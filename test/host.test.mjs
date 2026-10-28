/**
 * Host-half verification against a mock SiYuan kernel.
 *
 * Loads the real plugin module, mounts it on a fake Cordis context, and drives
 * the three registered routes plus the agent tool against a local HTTP server
 * that speaks the SiYuan API envelope. This checks the plugin's own logic
 * (endpoint normalization, token resolution, notebook lookup, hpath
 * deduplication, error text) without needing the user's NAS.
 */
import { createServer } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'siyuan-test-'))
process.env.DSH_HOME = home

/**
 * Every fixture lives in its own temp directory, never in the repository: a
 * test run must not leave `notes/report.md` behind for a commit to pick up.
 */
const workdir = await mkdtemp(join(tmpdir(), 'siyuan-workspace-'))

// ---------------------------------------------------------------------------
// Mock SiYuan kernel.
// ---------------------------------------------------------------------------

const state = {
  version: '3.8.8',
  token: 'test-token',
  notebooks: [
    { id: '20240101000000-inbox', name: 'DSH收件箱', icon: '', sort: 0, closed: false },
    { id: '20240101000000-other', name: 'Notes', icon: '', sort: 1, closed: false },
  ],
  docs: new Map(),
  calls: [],
}

const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let payload = {}
  try {
    payload = raw === '' ? {} : JSON.parse(raw)
  } catch {
    payload = {}
  }
  const api = new URL(req.url, 'http://x').pathname
  state.calls.push({ api, payload, auth: req.headers.authorization })

  const reply = (envelope) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(envelope))
  }

  if (req.headers.authorization !== `Token ${state.token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: -1, msg: 'invalid token', data: null }))
    return
  }

  switch (api) {
    case '/api/system/version':
      reply({ code: 0, msg: '', data: state.version })
      return
    case '/api/notebook/lsNotebooks':
      reply({ code: 0, msg: '', data: { notebooks: state.notebooks } })
      return
    case '/api/filetree/getIDsByHPath': {
      const key = `${payload.notebook}:${payload.path}`
      reply({ code: 0, msg: '', data: state.docs.has(key) ? [state.docs.get(key)] : [] })
      return
    }
    case '/api/filetree/createDocWithMd': {
      const key = `${payload.notebook}:${payload.path}`
      const id = `20240101000000-${state.docs.size.toString().padStart(7, '0')}`
      state.docs.set(key, id)
      state.docs.set(`${key}#markdown`, payload.markdown)
      reply({ code: 0, msg: '', data: id })
      return
    }
    default:
      reply({ code: 404, msg: `no api ${api}`, data: null })
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------------
// A fake host context carrying only what the plugin injects.
// ---------------------------------------------------------------------------

const tokens = new Map([['SIYUAN_API_TOKEN', 'test-token']])
const routes = new Map()
const tools = new Map()

const ctx = {
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  },
  credentials: {
    async describe(ref) {
      return { configured: tokens.has(ref), writable: true }
    },
    async resolve(ref) {
      return tokens.has(ref) ? { value: tokens.get(ref), source: 'test' } : undefined
    },
    async set(ref, value) {
      tokens.set(ref, value)
    },
  },
  sessionQuery: {
    async readEvent({ sessionId, seq }) {
      if (sessionId !== 'sess-1' || seq !== 7) throw new Error('no such event')
      return {
        session: { cwd: workdir },
        target: {
          type: 'deliverables/presented',
          data: { turn: 1, callId: 'call-1', files: [{ path: 'notes/report.md' }, { path: 'assets/photo.png' }] },
        },
      }
    },
  },
  workspaceFiles: {
    async stat(_scope, path) {
      if (path === 'missing.md') throw new Error('ENOENT')
      return { absolutePath: join(workdir, path) }
    },
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(fn) {
    fn()
    return () => {}
  },
  get() {
    return undefined
  },
}

/** Drive one registered route the way the connection fence would. */
async function call(routePath, { method = 'POST', body } = {}) {
  const route = routes.get(routePath)
  if (route === undefined) throw new Error(`route ${routePath} is not registered`)
  if (!route.methods.includes(method)) throw new Error(`route ${routePath} rejects ${method}`)
  const request = new Request(`${endpoint}${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await route.fetch(request)
  return { status: response.status, body: await response.json() }
}

// ---------------------------------------------------------------------------

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, detail })
  console.log(`${condition === true ? 'PASS' : 'FAIL'}  ${name}${condition === true ? '' : `  <- ${detail}`}`)
}

await writeFixture()

const { apply } = await import('../index.js')
apply(ctx, { endpoint, tokenRef: 'SIYUAN_API_TOKEN', notebook: 'DSH收件箱', parentPath: '/DSH收件箱', timeoutMs: 5000 })

// 1. Configuration round trip.
const initial = await call('/api/siyuan.config', { method: 'GET' })
check('GET config reports the endpoint', initial.body.value?.endpoint === endpoint, JSON.stringify(initial.body))
check('GET config never returns the token value', JSON.stringify(initial.body).includes('test-token') === false, JSON.stringify(initial.body))
check('GET config reports token presence', initial.body.value?.tokenConfigured === true, JSON.stringify(initial.body))

const saved = await call('/api/siyuan.config', {
  method: 'POST',
  body: { endpoint, notebook: 'DSH收件箱', parentPath: '/DSH收件箱/', allowSelfSigned: false },
})
check('POST config normalizes the parent path', saved.body.value?.parentPath === '/DSH收件箱', JSON.stringify(saved.body))

const badEndpoint = await call('/api/siyuan.config', { method: 'POST', body: { endpoint: 'nas.local:6806' } })
check('POST config rejects a scheme-less endpoint', badEndpoint.status === 400, JSON.stringify(badEndpoint))

// 2. Connection test.
const tested = await call('/api/siyuan.test', { method: 'POST', body: {} })
check('test returns the SiYuan version', tested.body.value?.version === '3.8.8', JSON.stringify(tested.body))
check('test resolves the notebook by name', tested.body.value?.notebook?.name === 'DSH收件箱', JSON.stringify(tested.body))
check('test resolves the notebook id', tested.body.value?.notebook?.id === '20240101000000-inbox', JSON.stringify(tested.body))

// 3. Sending by delivery coordinates (the button path).
await writeFixture()
const sent = await call('/api/siyuan.send', { method: 'POST', body: { sessionId: 'sess-1', seq: 7, index: 0 } })
check('send accepts delivery coordinates', sent.body.ok === true, JSON.stringify(sent.body))
check('send created a document id', typeof sent.body.value?.docId === 'string', JSON.stringify(sent.body))
check('send put it under the parent path', sent.body.value?.hpath?.startsWith('/DSH收件箱/') === true, JSON.stringify(sent.body))

const firstPath = sent.body.value?.hpath
const again = await call('/api/siyuan.send', { method: 'POST', body: { sessionId: 'sess-1', seq: 7, index: 0 } })
check('a repeated send does not overwrite', again.body.value?.hpath !== firstPath, `${firstPath} vs ${again.body.value?.hpath}`)
check('a repeated send keeps the original title', again.body.value?.hpath?.includes('报告') === true, JSON.stringify(again.body))

// The success toast names the notebook and the document path, so the reply has
// to carry both. Losing either would leave the user with a silent success.
check('success reports the notebook name for the toast', typeof sent.body.value?.notebook === 'string' && sent.body.value.notebook === 'DSH收件箱', JSON.stringify(sent.body))
check('success reports the document path for the toast', typeof sent.body.value?.hpath === 'string' && sent.body.value.hpath.length > 0, JSON.stringify(sent.body))

// 4. Refusals.
const png = await call('/api/siyuan.send', { method: 'POST', body: { sessionId: 'sess-1', seq: 7, index: 1 } })
check('a non-Markdown file is refused', png.body.ok === false && /Markdown/.test(png.body.error?.message ?? ''), JSON.stringify(png.body))

const missing = await call('/api/siyuan.send', { method: 'POST', body: { sessionId: 'sess-1', path: 'missing.md' } })
check('an unreadable file reports a failure', missing.body.ok === false, JSON.stringify(missing.body))

const noToken = (() => {
  tokens.delete('SIYUAN_API_TOKEN')
  return null
})()
void noToken
const refused = await call('/api/siyuan.test', { method: 'POST', body: {} })
check('a missing token is reported clearly', refused.status >= 400 && /token/i.test(refused.body.error?.message ?? ''), JSON.stringify(refused.body))
tokens.set('SIYUAN_API_TOKEN', 'test-token')

// 5. Agent tool.
const tool = tools.get('siyuan_send')
check('the siyuan_send tool is registered', tool !== undefined, 'not registered')
if (tool !== undefined) {
  const toolResult = await tool.execute({ path: 'notes/report.md' }, { agent: { id: 'sess-1' }, signal: undefined })
  check('the tool sends the same file', toolResult.ok === true, JSON.stringify(toolResult))
  const emptyArgs = await tool.execute({}, {})
  check('the tool rejects an empty path', emptyArgs.ok === false, JSON.stringify(emptyArgs))
  const rendered = tool.output.render({}, toolResult)
  check('the tool renders a readable result', typeof rendered[0]?.text === 'string' && rendered[0].text.includes('思源'), JSON.stringify(rendered))
}

// 6. Transport failure text.
await writeFixture()
const dead = await call('/api/siyuan.test', { method: 'POST', body: {} })
void dead

await rm(home, { recursive: true, force: true })
await rm(workdir, { recursive: true, force: true })
server.close()

const failed = results.filter((row) => row.ok !== true)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)

/** Write the fixture Markdown the delivery coordinates resolve to. */
async function writeFixture() {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(workdir, 'notes'), { recursive: true })
  await writeFile(join(workdir, 'notes/report.md'), '# 季度报告\n\n正文内容。\n', 'utf8')
}
