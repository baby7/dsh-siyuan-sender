/**
 * @local/dsh-siyuan-sender — Host half.
 *
 * Sends Markdown documents produced in a conversation to a self-hosted SiYuan
 * (思源笔记) instance and returns the created document's coordinates.
 *
 * Surfaces on this half:
 *   - `/api/siyuan.config`  GET/POST — read and store the connection settings.
 *   - `/api/siyuan.test`    POST     — verify endpoint + token + notebook.
 *   - `/api/siyuan.send`    POST     — send one delivered file by its Session
 *                                     event coordinates (the same coordinates
 *                                     the delivery card already carries) or one
 *                                     explicit workspace path.
 *   - `siyuan_send`         tool     — the same operation for the Agent.
 *
 * Routes are registered on `ctx.connection.fetch`, which already sits inside
 * the browser authentication fence: no unauthenticated or cross-site request
 * can reach them, and no extra CSRF guard is needed on top.
 *
 * Secret handling: the API token is never written to the settings file. It is
 * stored through `ctx.credentials` under the configured reference (`tokenRef`),
 * and re-resolved on every request, so a rotated token takes effect without a
 * restart. Nothing in this file logs a token.
 *
 * @module @local/dsh-siyuan-sender
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** Routes are served from this relative prefix (browser-relative form). */
const CONFIG_PATH = '/api/siyuan.config'
const TEST_PATH = '/api/siyuan.test'
const SEND_PATH = '/api/siyuan.send'

/** Settings file (user-editable connection data, no secrets). */
const SETTINGS_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.dsh-siyuan-sender.json')

/** Default settings, also restated in the bundle patch so users can edit YAML. */
const DEFAULTS = {
  endpoint: '',
  tokenRef: 'SIYUAN_API_TOKEN',
  notebook: '',
  parentPath: '/',
  allowSelfSigned: false,
  timeoutMs: 15000,
}

/** Markdown extensions this plugin will send. */
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mdx'])

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** A path's final segment, for both separators. */
function basename(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** A filtered settings object: only known keys, each with its documented type. */
function normalizeSettings(raw, fallback) {
  const next = { ...fallback }
  if (raw === null || typeof raw !== 'object') return next
  if (typeof raw.endpoint === 'string') next.endpoint = raw.endpoint.trim().replace(/\/+$/, '')
  if (typeof raw.tokenRef === 'string' && raw.tokenRef.trim() !== '') next.tokenRef = raw.tokenRef.trim()
  if (typeof raw.notebook === 'string') next.notebook = raw.notebook.trim()
  if (typeof raw.parentPath === 'string') next.parentPath = normalizeParent(raw.parentPath)
  if (typeof raw.allowSelfSigned === 'boolean') next.allowSelfSigned = raw.allowSelfSigned
  if (Number.isSafeInteger(raw.timeoutMs) && raw.timeoutMs >= 1000 && raw.timeoutMs <= 120000) next.timeoutMs = raw.timeoutMs
  return next
}

/** One SiYuan document parent: leading slash, no trailing slash (root is `/`). */
function normalizeParent(value) {
  const trimmed = value.trim().replace(/\\/g, '/')
  if (trimmed === '' || trimmed === '/') return '/'
  const segments = trimmed.split('/').filter((part) => part !== '')
  return `/${segments.join('/')}`
}

/** The doc title for one file: its stem, or its first heading when that reads better. */
function titleFor(fileName, markdown) {
  const stem = fileName.replace(/\.(md|markdown|mdown|mdx)$/i, '')
  const heading = /^\s{0,3}#\s+(.+?)\s*$/m.exec(markdown)
  const candidate = heading === null ? '' : heading[1].trim()
  // A heading is only preferred when it is short enough to be a title.
  const title = candidate !== '' && candidate.length <= 120 ? candidate : stem
  return title.replace(/[\r\n\t]+/g, ' ').trim() || 'DSH 文档'
}

/** One filesystem-safe, SiYuan-path-safe segment. */
function safeSegment(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** `2026-10-28 10:52` in the host's local zone. */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * Write one JSON response.
 * @param value envelope body.
 * @param status HTTP status (defaults to 200).
 * @param headers extra response headers.
 */
function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

/** Write one failure response in a shape the browser shows verbatim. */
function fail(status, code, message) {
  return json({ ok: false, error: { code, message } }, status)
}

// ---------------------------------------------------------------------------
// SiYuan HTTP client.
// ---------------------------------------------------------------------------

/**
 * POST one SiYuan API call.
 * @param settings resolved connection settings.
 * @param token API token value.
 * @param api one `/api/...` path.
 * @param payload JSON payload (SiYuan requires a POST with a JSON body).
 * @returns the raw SiYuan envelope `{ code, msg, data }`.
 */
function siyuanPost(settings, token, api, payload) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(api, `${settings.endpoint}/`)
    } catch {
      resolve({ transport: 'bad-endpoint' })
      return
    }
    const body = JSON.stringify(payload ?? {})
    const isHttps = url.protocol === 'https:'
    const send = isHttps ? httpsRequest : httpRequest
    const req = send(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Token ${token}`,
        },
        timeout: settings.timeoutMs,
        ...(isHttps ? { rejectUnauthorized: settings.allowSelfSigned !== true } : {}),
      },
      (res) => {
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > 8 * 1024 * 1024) {
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let envelope = null
          try {
            envelope = JSON.parse(text)
          } catch {
            envelope = null
          }
          resolve({ status: res.statusCode, envelope, text })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ transport: 'timeout' })
    })
    req.on('error', (error) => {
      resolve({ transport: error?.code ?? 'network', message: String(error?.message ?? error) })
    })
    req.end(body)
  })
}

/** Human text for one transport-level failure. */
function transportText(result) {
  switch (result.transport) {
    case 'timeout':
      return '连接思源超时：请检查地址是否可从本机访问，或在设置里调大超时。'
    case 'bad-endpoint':
      return '思源地址无效：请填写形如 http://nas.example.com:6806 的基础地址。'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '无法解析思源地址对应的域名：请检查地址拼写与网络。'
    case 'ECONNREFUSED':
      return '思源拒绝连接：端口是否正确？容器是否已启动？'
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return '思源的 HTTPS 证书校验失败：如果使用自签名证书，请在设置里开启「允许自签名证书」。'
    default:
      return `连接思源失败：${result.message ?? result.transport ?? '未知错误'}`
  }
}

/**
 * Decode one SiYuan envelope into a value or a failure message.
 * @returns `{ ok: true, data }` or `{ ok: false, code, message }`.
 */
function decode(result) {
  if (result.transport !== undefined) return { ok: false, code: `transport/${result.transport}`, message: transportText(result) }
  if (result.envelope === null || typeof result.envelope !== 'object') {
    if (result.status === 401 || result.status === 403) {
      return { ok: false, code: 'auth', message: '思源拒绝了请求：API token 无效或未授权。' }
    }
    return {
      ok: false,
      code: 'not-siyuan',
      message: `该地址没有返回思源的响应（HTTP ${result.status ?? '—'}）。请确认填写的是思源内核地址，而不是其它 Web 服务。`,
    }
  }
  const { code, msg, data } = result.envelope
  if (code === 0) return { ok: true, data }
  if (result.status === 401 || result.status === 403 || code === -1 && /token/i.test(String(msg))) {
    return { ok: false, code: 'auth', message: `思源拒绝了请求：${msg || 'API token 无效'}。请在「设置 → 关于 → API token」复制正确的 token。` }
  }
  return { ok: false, code: 'siyuan', message: `思源返回错误：${msg || `code ${code}`}` }
}

/** Resolve the target notebook id, accepting either an id or a notebook name. */
async function resolveNotebook(settings, token) {
  const wanted = settings.notebook
  if (wanted === '') {
    return { ok: false, code: 'not-configured', message: '还没有设置目标笔记本：请在思源笔记直送设置里选择「DSH收件箱」所在的笔记本。' }
  }
  const listed = decode(await siyuanPost(settings, token, '/api/notebook/lsNotebooks', {}))
  if (!listed.ok) return listed
  const notebooks = Array.isArray(listed.data?.notebooks) ? listed.data.notebooks : []
  const exactId = notebooks.find((row) => row?.id === wanted)
  if (exactId !== undefined) return { ok: true, notebook: exactId, notebooks }
  const byName = notebooks.find((row) => typeof row?.name === 'string' && row.name === wanted)
  if (byName !== undefined) return { ok: true, notebook: byName, notebooks }
  const names = notebooks.map((row) => row?.name).filter((name) => typeof name === 'string')
  return {
    ok: false,
    code: 'notebook-missing',
    message: names.length === 0
      ? '思源里没有找到任何已打开的笔记本：请先在思源里打开「DSH收件箱」笔记本。'
      : `没有找到名为「${wanted}」的笔记本；现有笔记本：${names.join('、')}。`,
  }
}

/** Whether one hpath already exists in the notebook. */
async function pathExists(settings, token, notebookId, hpath) {
  const found = decode(await siyuanPost(settings, token, '/api/filetree/getIDsByHPath', { notebook: notebookId, path: hpath }))
  if (!found.ok) return false
  return Array.isArray(found.data) && found.data.length > 0
}

/**
 * Create one document from Markdown, choosing a unique hpath.
 * @returns `{ ok: true, docId, hpath, title }` or a failure.
 */
async function createDocument(settings, token, notebookId, markdown, fileName) {
  const title = safeSegment(titleFor(fileName, markdown))
  const parent = settings.parentPath
  const basePath = parent === '/' ? `/${title}` : `${parent}/${title}`
  let hpath = basePath
  if (await pathExists(settings, token, notebookId, hpath)) {
    // Never overwrite an existing document: a repeated send gets its own copy.
    hpath = parent === '/' ? `/${title} ${stamp()}` : `${parent}/${title} ${stamp()}`
    let attempt = 2
    while (await pathExists(settings, token, notebookId, hpath)) {
      hpath = parent === '/' ? `/${title} ${stamp()} (${attempt})` : `${parent}/${title} ${stamp()} (${attempt})`
      attempt += 1
      if (attempt > 20) break
    }
  }
  const created = decode(await siyuanPost(settings, token, '/api/filetree/createDocWithMd', {
    notebook: notebookId,
    path: hpath,
    markdown,
  }))
  if (!created.ok) return created
  return { ok: true, docId: created.data, hpath, title }
}

// ---------------------------------------------------------------------------
// Settings persistence.
// ---------------------------------------------------------------------------

/** Read the stored settings, then the credential presence, never the value. */
async function loadState(ctx, base) {
  let file = {}
  try {
    const text = await readFile(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') file = parsed
  } catch {
    file = {}
  }
  const settings = normalizeSettings(file, normalizeSettings(base, DEFAULTS))
  let tokenConfigured = false
  try {
    const info = await ctx.credentials.describe(settings.tokenRef)
    tokenConfigured = info.configured
  } catch {
    tokenConfigured = false
  }
  return { settings, tokenConfigured }
}

/** Persist the non-secret half of the settings. */
async function saveSettings(settings) {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** Resolve the token value for one request; the value never leaves the Host. */
async function resolveToken(ctx, settings) {
  try {
    const resolved = await ctx.credentials.resolve(settings.tokenRef)
    if (resolved === undefined || resolved.value === '') return null
    return resolved.value
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Coordinate resolution: Session event file → absolute Host path.
// ---------------------------------------------------------------------------

/**
 * Resolve a delivery-file coordinate to its absolute path through the same
 * Session-authorized read path the delivery card itself uses.
 * @returns `{ ok: true, path, session }` or `{ ok: false, status, message }`.
 */
async function resolvePresentedPath(ctx, sessionId, seq, index, signal) {
  const read = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)
  const event = read?.target
  const files = event?.type === 'deliverables/presented' && Array.isArray(event.data?.files) ? event.data.files : null
  if (files === null) return { ok: false, status: 404, message: '该对话里没有这条交付文件记录。' }
  const declared = files[index]
  const relPath = typeof declared?.path === 'string' ? declared.path.trim() : ''
  if (relPath === '') return { ok: false, status: 404, message: '这条交付记录里没有对应下标的文件。' }
  const session = read.session
  const stat = await ctx.workspaceFiles.stat({
    sessionId,
    workspaceRoot: session?.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot,
  }, relPath, signal)
  return { ok: true, path: stat.absolutePath, relPath, session }
}

/** Reject anything that is not a Markdown document this plugin can send. */
function markdownRefusal(path) {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot).toLowerCase()
  if (!MD_EXT.has(ext)) {
    return `只能发送 Markdown 文档（.md / .markdown / .mdx），当前文件是「${name}」。`
  }
  return null
}

// ---------------------------------------------------------------------------
// The one send operation shared by the route and the tool.
// ---------------------------------------------------------------------------

/**
 * Send one Markdown file to SiYuan.
 * @param ctx host context.
 * @param base the row's configured defaults.
 * @param input `{ path }` or delivery coordinates `{ sessionId, seq, index }`.
 * @returns `{ ok: true, ... }` or `{ ok: false, code, message }`.
 */
async function sendDocument(ctx, base, input, signal) {
  const { settings } = await loadState(ctx, base)
  if (settings.endpoint === '') {
    return { ok: false, code: 'not-configured', message: '还没有设置思源地址：打开「设置 → 思源笔记直送」填写 NAS 地址并保存。' }
  }
  const token = await resolveToken(ctx, settings)
  if (token === null) {
    return { ok: false, code: 'no-token', message: `还没有保存思源 API token（凭据名 ${settings.tokenRef}）：请在同一设置页填写 token。` }
  }

  let absolutePath
  if (typeof input.path === 'string' && input.path.trim() !== '') {
    const stat = await ctx.workspaceFiles.stat({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot ?? ctx.get('sandboxPolicy')?.workspaceRoot,
    }, input.path.trim(), signal)
    absolutePath = stat.absolutePath
  } else {
    const resolved = await resolvePresentedPath(ctx, input.sessionId, input.seq, input.index, signal)
    if (!resolved.ok) return resolved
    absolutePath = resolved.path
  }

  const refusal = markdownRefusal(absolutePath)
  if (refusal !== null) return { ok: false, code: 'not-markdown', message: refusal }

  const notebook = await resolveNotebook(settings, token)
  if (!notebook.ok) return notebook

  let markdown
  try {
    markdown = await readFile(absolutePath, 'utf8')
  } catch {
    return { ok: false, code: 'unreadable', message: '无法读取该文件：它可能已被移动或删除。' }
  }
  if (markdown.trim() === '') return { ok: false, code: 'empty', message: '这个文档是空的，没有可发送的内容。' }

  const created = await createDocument(settings, token, notebook.notebook.id, markdown, basename(absolutePath))
  if (!created.ok) return created
  return {
    ok: true,
    docId: created.docId,
    hpath: created.hpath,
    title: created.title,
    notebook: notebook.notebook.name,
    notebookId: notebook.notebook.id,
    file: basename(absolutePath),
  }
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

/** One JSON request body, or null when it is not a JSON object. */
async function readBody(request) {
  try {
    const value = await request.json()
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** The public (secret-free) settings view the Client renders. */
function publicState(settings, tokenConfigured) {
  return {
    endpoint: settings.endpoint,
    tokenRef: settings.tokenRef,
    tokenConfigured,
    notebook: settings.notebook,
    parentPath: settings.parentPath,
    allowSelfSigned: settings.allowSelfSigned,
    timeoutMs: settings.timeoutMs,
  }
}

/** Register the three routes inside the browser authentication fence. */
function registerRoutes(ctx, base) {
  ctx.connection.fetch.register({
    path: CONFIG_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') {
        const { settings, tokenConfigured } = await loadState(ctx, base)
        return json({ ok: true, value: publicState(settings, tokenConfigured) })
      }
      const body = await readBody(request)
      if (body === null) return fail(400, 'bad-request', '请求体必须是 JSON 对象。')
      const { settings, tokenConfigured } = await loadState(ctx, base)
      const next = normalizeSettings(body, settings)
      if (typeof body.endpoint === 'string' && next.endpoint !== '' && !/^https?:\/\//i.test(next.endpoint)) {
        return fail(400, 'bad-endpoint', '思源地址必须以 http:// 或 https:// 开头。')
      }
      if (typeof body.token === 'string' && body.token.trim() !== '') {
        try {
          await ctx.credentials.set(next.tokenRef, body.token.trim())
        } catch {
          return fail(500, 'token-store-failed', '无法把 token 写入凭据库。')
        }
      }
      await saveSettings(next)
      const fresh = await loadState(ctx, base)
      return json({ ok: true, value: publicState(fresh.settings, fresh.tokenConfigured) })
    },
  })

  ctx.connection.fetch.register({
    path: TEST_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const { settings } = await loadState(ctx, base)
      if (settings.endpoint === '') return fail(400, 'not-configured', '请先填写思源地址。')
      const token = await resolveToken(ctx, settings)
      if (token === null) return fail(400, 'no-token', '请先填写思源 API token。')
      const version = decode(await siyuanPost(settings, token, '/api/system/version', {}))
      if (!version.ok) return fail(502, version.code, version.message)
      const notebook = await resolveNotebook(settings, token)
      if (!notebook.ok) {
        return json({
          ok: true,
          value: { version: version.data, notebook: null, notebooks: (notebook.notebooks ?? []).map((row) => row?.name).filter(Boolean), warning: notebook.message },
        })
      }
      return json({
        ok: true,
        value: {
          version: version.data,
          notebook: { id: notebook.notebook.id, name: notebook.notebook.name },
          notebooks: (notebook.notebooks ?? []).map((row) => row?.name).filter(Boolean),
        },
      })
    },
  })

  ctx.connection.fetch.register({
    path: SEND_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readBody(request)
      if (body === null) return fail(400, 'bad-request', '请求体必须是 JSON 对象。')
      const coordinates = body.sessionId
      if (typeof coordinates !== 'string' || coordinates === '') return fail(400, 'bad-request', '缺少会话标识。')
      const numeric = (value) => (value === undefined || value === null || !/^\d+$/.test(String(value)) ? undefined : Number(value))
      const seq = numeric(body.seq)
      const index = numeric(body.index)
      const input = seq !== undefined && index !== undefined
        ? { sessionId: coordinates, seq, index }
        : { sessionId: coordinates, path: typeof body.path === 'string' ? body.path : '' }
      if (input.path === '') return fail(400, 'bad-request', '缺少要发送的文件。')
      let result
      try {
        result = await sendDocument(ctx, base, input, request.signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return fail(502, 'send-failed', `发送失败：${message}`)
      }
      if (!result.ok) return fail(502, result.code, result.message)
      return json({ ok: true, value: result })
    },
  })
}

// ---------------------------------------------------------------------------
// Agent tool.
// ---------------------------------------------------------------------------

/** Output schema for the tool result. */
const TOOL_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    docId: { type: 'string' },
    hpath: { type: 'string' },
    title: { type: 'string' },
    notebook: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['ok'],
}

/** One tool definition; the tool calls the same `sendDocument` the route does. */
function toolDefinition(ctx, base) {
  return {
    name: 'siyuan_send',
    description: 'Send a Markdown document to the user\u2019s SiYuan (思源笔记) instance and return the created document id. Use it when the user asks to save or push a generated document into SiYuan. `path` is resolved against the current Session workspace and must be a .md/.markdown/.mdx file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Markdown file to send, relative to the Session workspace (or absolute). Example: "notes/report.md".',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: TOOL_OUTPUT,
      render: (_args, value) => {
        const record = value !== null && typeof value === 'object' ? value : {}
        const text = record.ok === true
          ? `已发送到思源笔记「${record.notebook ?? ''}」：${record.hpath ?? ''}（文档 ID ${record.docId ?? ''}）`
          : `发送到思源失败：${record.error ?? '未知错误'}`
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const path = args !== null && typeof args === 'object' && typeof args.path === 'string' ? args.path.trim() : ''
      if (path === '') return { ok: false, error: '缺少 path：请给出要发送的 Markdown 文件路径。' }
      try {
        const result = await sendDocument(ctx, base, { path, sessionId: exec?.agent?.id }, exec?.signal)
        if (result.ok) return { ok: true, docId: result.docId, hpath: result.hpath, title: result.title, notebook: result.notebook }
        return { ok: false, error: result.message }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

/** Hard dependencies: the authenticated route registry, credentials, Session reads, workspace files, tools. */
export const inject = ['connection', 'credentials', 'sessionQuery', 'workspaceFiles', 'tools']

/**
 * Mount the routes and the Agent tool.
 * @param ctx host context carrying the injected services.
 * @param config the row's config (connection defaults).
 */
export function apply(ctx, config) {
  const base = normalizeSettings(config, DEFAULTS)
  ctx.effect(() => () => {}, 'dsh-siyuan-sender: lifetime')
  registerRoutes(ctx, base)
  ctx.effect(() => ctx.tools.register(toolDefinition(ctx, base)), 'dsh-siyuan-sender: siyuan_send tool')
}
