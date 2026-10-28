/**
 * @local/dsh-siyuan-sender — Client half.
 *
 * Three seats, one operation:
 *
 *  1. `deliverables.file.actions` — the button row inside every delivered-file
 *     card. The owner props carry `actionUrl`, whose query holds the file's
 *     `sessionId`, `seq` and `index`, so the button sends exactly the file whose
 *     card it sits on and the Host re-derives the real path through its own
 *     Session-authorized route. The browser never names a filesystem path.
 *  2. `sidebar.right.tab.document.actions` — the document-preview toolbar, for a
 *     Markdown file already open in the right sidebar.
 *  3. `settings.section` — the connection page: endpoint, token, notebook,
 *     parent path, and a live connection test.
 *
 * Loader contract: this file is served verbatim by dsh-client-modules. The
 * factory receives the shell's module table and its return value becomes the
 * module exports (`{ inject, apply }`). React comes from that table, so the
 * bundle has no dependencies and no build step.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-siyuan-sender',
  factory(require) {
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'siyuanSender'
    const CONFIG_ROUTE = 'api/siyuan.config'
    const TEST_ROUTE = 'api/siyuan.test'
    const SEND_ROUTE = 'api/siyuan.send'

    // -----------------------------------------------------------------------
    // Copy.
    // -----------------------------------------------------------------------

    const zh = {
      'action.send': '发送到思源',
      'action.sendShort': '思源',
      'action.sending': '发送中…',
      'action.sent': '已发送',
      'action.retry': '发送失败，点击重试',
      'action.retryShort': '重试',
      'toast.ok': '已发送到思源「{notebook}」',
      'toast.error': '发送失败',
      'settings.title': '思源笔记直送',
      'settings.description': '把对话里生成的 Markdown 文档发送到自建的思源笔记（SiYuan）。',
      'settings.endpoint': '思源地址',
      'settings.endpointHint': '填到端口即可，例如 http://nas.example.com:6806；不要在末尾加 /api。',
      'settings.token': 'API token',
      'settings.tokenHint': '思源「设置 → 关于 → API token」里的值。只存入本机凭据库，不写入设置文件。',
      'settings.tokenConfigured': '已保存 token，留空表示保持不变。',
      'settings.tokenMissing': '还没有保存 token。',
      'settings.notebook': '目标笔记本',
      'settings.notebookHint': '笔记本名称或 ID，例如「DSH收件箱」。',
      'settings.parentPath': '父文档路径',
      'settings.parentPathHint': '笔记本内的存放路径，例如 /DSH收件箱；填 / 表示放在笔记本根目录。',
      'settings.allowSelfSigned': '允许自签名证书',
      'settings.allowSelfSignedHint': '仅当思源使用自签名 HTTPS 证书时开启。',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.saved': '已保存',
      'settings.saveFailed': '保存失败',
      'settings.test': '测试连接',
      'settings.testing': '测试中…',
      'settings.testOk': '连接成功：思源 {version}，笔记本「{notebook}」',
      'settings.testWarn': '思源 {version} 连接正常，但：{warning}',
      'settings.testFailed': '测试失败',
      'settings.loading': '读取设置…',
      'settings.loadFailed': '无法读取设置',
      'settings.invalidEndpoint': '地址必须以 http:// 或 https:// 开头',
    }

    const en = {
      'action.send': 'Send to SiYuan',
      'action.sendShort': 'SiYuan',
      'action.sending': 'Sending…',
      'action.sent': 'Sent',
      'action.retry': 'Send failed, click to retry',
      'action.retryShort': 'Retry',
      'toast.ok': 'Sent to SiYuan “{notebook}”',
      'toast.error': 'Send failed',
      'settings.title': 'SiYuan',
      'settings.description': 'Send Markdown documents from the conversation to your self-hosted SiYuan instance.',
      'settings.endpoint': 'SiYuan address',
      'settings.endpointHint': 'Include the port, e.g. http://nas.example.com:6806; do not append /api.',
      'settings.token': 'API token',
      'settings.tokenHint': 'From SiYuan Settings → About → API token. Stored in the local credential store, never in the settings file.',
      'settings.tokenConfigured': 'A token is saved; leave blank to keep it.',
      'settings.tokenMissing': 'No token saved yet.',
      'settings.notebook': 'Target notebook',
      'settings.notebookHint': 'Notebook name or id, e.g. “DSH inbox”.',
      'settings.parentPath': 'Parent path',
      'settings.parentPathHint': 'Path inside the notebook, e.g. /DSH-inbox; “/” means the notebook root.',
      'settings.allowSelfSigned': 'Allow self-signed certificate',
      'settings.allowSelfSignedHint': 'Only when SiYuan serves HTTPS with a self-signed certificate.',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved',
      'settings.saveFailed': 'Could not save',
      'settings.test': 'Test connection',
      'settings.testing': 'Testing…',
      'settings.testOk': 'Connected: SiYuan {version}, notebook “{notebook}”',
      'settings.testWarn': 'SiYuan {version} reachable, but: {warning}',
      'settings.testFailed': 'Test failed',
      'settings.loading': 'Loading settings…',
      'settings.loadFailed': 'Could not load settings',
      'settings.invalidEndpoint': 'The address must start with http:// or https://',
    }

    // -----------------------------------------------------------------------
    // Style: theme tokens only, namespaced class prefix.
    // -----------------------------------------------------------------------

    const CLASS = {
      tool: 'syw-tool',
      bubble: 'syw-bubble',
      section: 'syw-section',
      row: 'syw-row',
      label: 'syw-label',
      hint: 'syw-hint',
      input: 'syw-input',
      actions: 'syw-actions',
      button: 'syw-button',
      status: 'syw-status',
    }

    const CSS = `
.syw-tool{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);height:24px;font-family:var(--dsw-font-family);align-items:center;color:var(--dsw-alias-label-primary);white-space:nowrap;cursor:pointer;background:0 0;justify-content:center;gap:4px;padding:3px 5px;font-size:11px;line-height:16px;display:inline-flex}
.syw-tool:hover:not(:disabled),.syw-tool:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.syw-tool:disabled{cursor:default}
.syw-tool:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.syw-tool svg{flex:none;display:block;width:13px;height:13px}
.syw-tool[data-state=sent]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.syw-tool[data-state=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.syw-tool[data-size=regular]{height:28px;padding:0 8px;font-size:12px;line-height:20px;gap:5px;border-color:transparent}
.syw-tool[data-size=regular]:hover:not(:disabled),.syw-tool[data-size=regular]:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.syw-tool[data-size=regular] svg{width:15px;height:15px}
.syw-bubble{position:fixed;z-index:1000;max-width:340px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 6px 24px rgba(0,0,0,.18);padding:9px 12px;font-size:12px;line-height:18px;white-space:normal;text-align:left;pointer-events:none;animation:syw-toast-in .14s ease-out}
.syw-bubble::after{content:"";position:absolute;top:100%;right:14px;border:5px solid transparent;border-top-color:var(--dsw-alias-bg-layer-2)}
.syw-bubble[data-tone=ok]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);color:var(--dsw-alias-label-primary)}
.syw-bubble[data-tone=ok] .syw-bubbleTitle{color:var(--dsw-alias-state-success-primary)}
.syw-bubble[data-tone=error]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-label-primary)}
.syw-bubble[data-tone=error] .syw-bubbleTitle{color:var(--dsw-alias-state-error-primary)}
.syw-bubbleTitle{font-weight:500;display:block}
.syw-bubblePath{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:block;margin-top:2px;word-break:break-all}
@keyframes syw-toast-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.syw-section{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px}
.syw-row{display:flex;flex-direction:column;gap:5px}
.syw-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.syw-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.syw-input{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px;min-height:30px}
.syw-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}
.syw-actions{display:flex;align-items:center;gap:8px}
.syw-button{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);height:30px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;background:var(--dsw-alias-bg-layer-1);align-items:center;justify-content:center;gap:6px;padding:0 12px;font-size:13px;line-height:20px;display:inline-flex}
.syw-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.syw-button:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.syw-button:disabled{cursor:default;opacity:.6}
.syw-status{font-size:12px;line-height:18px;margin:0}
.syw-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.syw-status[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.syw-status[data-kind=pending]{color:var(--dsw-alias-label-tertiary)}
`

    /**
     * A standalone cell for the delivered-file row. The shipped "open in app"
     * control is a split button whose own box provides the visible border; ours
     * is a separate button, so it takes the same border, height and type, and
     * this wrapper adds the gap that keeps the two from touching.
     */
    const SEPARATED = { position: 'relative', display: 'inline-flex', marginLeft: 6, flex: 'none' }

    /** Install the stylesheet once per page; unmounting the owner removes it. */
    function Styles() {
      React.useEffect(() => {
        const tagId = '@local/dsh-siyuan-sender/siyuan-sender.css'
        if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return undefined
        const tag = document.createElement('style')
        tag.dataset.plugin = '@local/dsh-siyuan-sender'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, [])
      return null
    }

    // -----------------------------------------------------------------------
    // Host API helper.
    // -----------------------------------------------------------------------

    /** One JSON response body, or a failure envelope when the route failed. */
    async function callJson(url, init) {
      try {
        const response = await fetch(url, init)
        const value = await response.json()
        if (value === null || typeof value !== 'object') return { ok: false, error: { message: `HTTP ${response.status}` } }
        return value
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    }

    /** The paper-plane glyph drawn inline, sized like the neighbouring app icon. */
    function SendIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M14.2 1.8 1.9 6.4l4.3 1.7 1.7 4.3 6.3-10.6Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M6.2 8.1 9.6 4.7', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    // -----------------------------------------------------------------------
    // The send control shared by both file seats.
    // -----------------------------------------------------------------------

    /**
     * A toast anchored under a control, rendered through a portal.
     *
     * The delivered-file card sets `overflow:hidden` and
     * `container-type:inline-size`, so an absolutely positioned child inside the
     * card is clipped AND a `position:fixed` child would be contained by the
     * card's inline-size container. A portal into `document.body` escapes both,
     * which is why the feedback cannot simply be an inline sibling.
     * @param props `{ anchor, tone, title, detail, t }`.
     */
    function FeedbackToast(props) {
      const { anchor, tone, title, detail } = props
      const [position, setPosition] = React.useState(null)

      React.useLayoutEffect(() => {
        const place = () => {
          const element = anchor.current
          if (element === null || !element.isConnected) return
          const rect = element.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          setPosition({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [anchor])

      if (position === null) return null
      return ReactDOM.createPortal(
        h(
          'div',
          {
            className: CLASS.bubble,
            'data-tone': tone,
            role: tone === 'error' ? 'alert' : 'status',
            'aria-live': tone === 'error' ? 'assertive' : 'polite',
            style: { top: position.top, right: position.right },
          },
          h('span', { className: 'syw-bubbleTitle' }, title),
          detail === undefined || detail === '' ? null : h('span', { className: 'syw-bubblePath' }, detail),
        ),
        document.body,
      )
    }

    /**
     * One send button with its own visible result.
     *
     * Feedback is deliberately layered, because a button that only swaps its
     * label is easy to miss:
     *   - the button itself turns green/red and shows 「已发送」/「重试」;
     *   - a toast under the clicked control names the notebook and the document
     *     path on success, or the reason on failure;
     *   - the success toast stays long enough to read the path.
     * @param props `{ body, t, disabled, compact }`; `body` is the POST payload
     *   naming either delivery coordinates or an explicit workspace path, and
     *   `t` is the namespace translator bound in `apply`.
     */
    function SendButton(props) {
      const { body, t, disabled, compact } = props
      const [phase, setPhase] = React.useState('idle')
      const [feedback, setFeedback] = React.useState(null)
      const anchor = React.useRef(null)
      const timer = React.useRef(undefined)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
          clearTimeout(timer.current)
        }
      }, [])

      const run = async () => {
        if (body === null) return
        clearTimeout(timer.current)
        setPhase('sending')
        setFeedback(null)
        const result = await callJson(SEND_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!alive.current) return
        if (result.ok === true) {
          const value = result.value ?? {}
          setPhase('sent')
          setFeedback({
            tone: 'ok',
            title: t('toast.ok', { notebook: String(value.notebook ?? '') }),
            detail: String(value.hpath ?? ''),
          })
          timer.current = setTimeout(() => {
            if (!alive.current) return
            setPhase('idle')
            setFeedback(null)
          }, 7000)
          return
        }
        setPhase('error')
        setFeedback({ tone: 'error', title: t('toast.error'), detail: result.error?.message ?? '' })
        timer.current = setTimeout(() => {
          if (!alive.current) return
          setFeedback(null)
        }, 12000)
      }

      const text =
        phase === 'sending'
          ? t('action.sending')
          : phase === 'sent'
            ? t('action.sent')
            : phase === 'error'
              ? compact
                ? t('action.retryShort')
                : t('action.retry')
              : compact
                ? t('action.sendShort')
                : t('action.send')
      const hint = feedback === null ? t('action.send') : `${feedback.title}${feedback.detail === '' ? '' : ` — ${feedback.detail}`}`
      return h(
        'span',
        { ref: anchor, style: compact === true ? SEPARATED : { display: 'inline-flex', flex: 'none' } },
        h(
          'button',
          {
            type: 'button',
            className: CLASS.tool,
            'data-size': compact === true ? undefined : 'regular',
            'data-state': phase === 'error' ? 'error' : phase === 'sent' ? 'sent' : 'idle',
            'aria-label': hint,
            'aria-busy': phase === 'sending' ? true : undefined,
            title: hint,
            disabled: disabled === true || phase === 'sending',
            onClick: () => {
              void run()
            },
          },
          h(SendIcon),
          h('span', null, text),
        ),
        feedback === null
          ? null
          : h(FeedbackToast, { anchor, tone: feedback.tone, title: feedback.title, detail: feedback.detail, t }),
      )
    }

    /** Whether a display path looks like a Markdown document. */
    function isMarkdown(path) {
      return typeof path === 'string' && /\.(md|markdown|mdown|mdx)$/i.test(path)
    }

    // -----------------------------------------------------------------------
    // Seat 1: delivered-file card actions.
    // -----------------------------------------------------------------------

    /**
     * The delivered-file row button.
     * @param t namespace translator bound in `apply`.
     * @returns the slot component.
     */
    function deliveryAction(t) {
      return function DeliveryAction(props) {
        const { actionUrl, sessionId } = props
        const body = React.useMemo(() => {
          if (typeof actionUrl !== 'string' || actionUrl === '') return null
          const at = actionUrl.indexOf('?')
          if (at === -1) return null
          const query = new URLSearchParams(actionUrl.slice(at + 1))
          const seq = query.get('seq')
          const index = query.get('index')
          const id = query.get('sessionId') ?? sessionId
          if (id === undefined || id === '' || seq === null || index === null) return null
          if (!/^\d+$/.test(seq) || !/^\d+$/.test(index)) return null
          return { sessionId: id, seq: Number(seq), index: Number(index) }
        }, [actionUrl, sessionId])
        if (body === null) return null
        return h(SendButton, { body, t, disabled: props.pending === true, compact: true })
      }
    }

    // -----------------------------------------------------------------------
    // Seat 2: document-preview toolbar.
    // -----------------------------------------------------------------------

    /**
     * The preview-toolbar button. Owner props carry the previewed file's Host
     * path; a non-Markdown file contributes nothing.
     * @param t namespace translator bound in `apply`.
     * @returns the slot component.
     */
    function previewAction(t) {
      return function PreviewAction(props) {
        const { absolutePath, path, sessionId } = props
        const target = typeof absolutePath === 'string' ? absolutePath : typeof path === 'string' ? path : ''
        if (!isMarkdown(target) || typeof sessionId !== 'string' || sessionId === '') return null
        return h(SendButton, { body: { sessionId, path: target }, t, disabled: props.pending === true, compact: false })
      }
    }

    // -----------------------------------------------------------------------
    // Seat 3: settings section.
    // -----------------------------------------------------------------------

    /** One labelled field with its hint. */
    function Field(props) {
      return h(
        'div',
        { className: CLASS.row },
        h('label', { className: CLASS.label, htmlFor: props.id }, props.label),
        props.children,
        props.hint === undefined ? null : h('p', { className: CLASS.hint }, props.hint),
      )
    }

    /**
     * The settings page: connection data, token, notebook, and a live test.
     * @param t namespace translator bound in `apply`.
     * @returns the slot component.
     */
    function settingsSection(t) {
      return function SettingsSection() {
        const [state, setState] = React.useState(null)
        const [loadError, setLoadError] = React.useState('')
        const [form, setForm] = React.useState({
          endpoint: '',
          token: '',
          notebook: '',
          parentPath: '/',
          allowSelfSigned: false,
        })
        const [busy, setBusy] = React.useState('')
        const [status, setStatus] = React.useState({ kind: 'pending', text: '' })

        React.useEffect(() => {
          let alive = true
          void (async () => {
            const result = await callJson(CONFIG_ROUTE)
            if (!alive) return
            if (result.ok !== true) {
              setLoadError(result.error?.message ?? t('settings.loadFailed'))
              return
            }
            const value = result.value ?? {}
            setState(value)
            setForm({
              endpoint: value.endpoint ?? '',
              token: '',
              notebook: value.notebook ?? '',
              parentPath: value.parentPath ?? '/',
              allowSelfSigned: value.allowSelfSigned === true,
            })
          })()
          return () => {
            alive = false
          }
        }, [])

        const patch = (key, value) => setForm((current) => ({ ...current, [key]: value }))

        const save = async () => {
          if (form.endpoint !== '' && !/^https?:\/\//i.test(form.endpoint)) {
            setStatus({ kind: 'error', text: t('settings.invalidEndpoint') })
            return
          }
          setBusy('save')
          setStatus({ kind: 'pending', text: t('settings.saving') })
          const payload = { ...form }
          if (payload.token.trim() === '') delete payload.token
          const result = await callJson(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          setBusy('')
          if (result.ok !== true) {
            setStatus({ kind: 'error', text: result.error?.message ?? t('settings.saveFailed') })
            return
          }
          setState(result.value ?? null)
          setForm((current) => ({ ...current, token: '' }))
          setStatus({ kind: 'ok', text: t('settings.saved') })
        }

        const test = async () => {
          setBusy('test')
          setStatus({ kind: 'pending', text: t('settings.testing') })
          const result = await callJson(TEST_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          setBusy('')
          if (result.ok !== true) {
            setStatus({ kind: 'error', text: result.error?.message ?? t('settings.testFailed') })
            return
          }
          const value = result.value ?? {}
          const version = String(value.version ?? '?')
          if (value.notebook === null || value.notebook === undefined) {
            setStatus({ kind: 'error', text: t('settings.testWarn', { version, warning: String(value.warning ?? '') }) })
            return
          }
          setStatus({ kind: 'ok', text: t('settings.testOk', { version, notebook: String(value.notebook.name ?? '') }) })
        }

        if (state === null) {
          return h(
            'section',
            { className: CLASS.section, 'data-siyuan-settings': true },
            h(Styles),
            h('p', { className: CLASS.hint }, loadError === '' ? t('settings.loading') : loadError),
          )
        }

        return h(
          'section',
          { className: CLASS.section, 'data-siyuan-settings': true },
          h(Styles),
          h('p', { className: CLASS.hint }, t('settings.description')),
          h(
            Field,
            { id: 'syw-endpoint', label: t('settings.endpoint'), hint: t('settings.endpointHint') },
            h('input', {
              id: 'syw-endpoint',
              className: CLASS.input,
              type: 'text',
              value: form.endpoint,
              placeholder: 'http://nas.example.com:6806',
              onChange: (event) => patch('endpoint', event.target.value),
            }),
          ),
          h(
            Field,
            { id: 'syw-token', label: t('settings.token'), hint: t('settings.tokenHint') },
            h('input', {
              id: 'syw-token',
              className: CLASS.input,
              type: 'password',
              autoComplete: 'off',
              value: form.token,
              placeholder: state.tokenConfigured === true ? '••••••••' : '',
              onChange: (event) => patch('token', event.target.value),
            }),
            h('p', { className: CLASS.hint }, state.tokenConfigured === true ? t('settings.tokenConfigured') : t('settings.tokenMissing')),
          ),
          h(
            Field,
            { id: 'syw-notebook', label: t('settings.notebook'), hint: t('settings.notebookHint') },
            h('input', {
              id: 'syw-notebook',
              className: CLASS.input,
              type: 'text',
              value: form.notebook,
              placeholder: 'DSH收件箱',
              onChange: (event) => patch('notebook', event.target.value),
            }),
          ),
          h(
            Field,
            { id: 'syw-parent', label: t('settings.parentPath'), hint: t('settings.parentPathHint') },
            h('input', {
              id: 'syw-parent',
              className: CLASS.input,
              type: 'text',
              value: form.parentPath,
              placeholder: '/DSH收件箱',
              onChange: (event) => patch('parentPath', event.target.value),
            }),
          ),
          h(
            'div',
            { className: CLASS.row },
            h(
              'label',
              { className: CLASS.label, htmlFor: 'syw-self-signed', style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                id: 'syw-self-signed',
                type: 'checkbox',
                checked: form.allowSelfSigned,
                onChange: (event) => patch('allowSelfSigned', event.target.checked),
              }),
              t('settings.allowSelfSigned'),
            ),
            h('p', { className: CLASS.hint }, t('settings.allowSelfSignedHint')),
          ),
          h(
            'div',
            { className: CLASS.actions },
            h(
              'button',
              { type: 'button', className: CLASS.button, disabled: busy !== '', onClick: () => void save() },
              busy === 'save' ? t('settings.saving') : t('settings.save'),
            ),
            h(
              'button',
              { type: 'button', className: CLASS.button, disabled: busy !== '', onClick: () => void test() },
              busy === 'test' ? t('settings.testing') : t('settings.test'),
            ),
          ),
          status.text === ''
            ? null
            : h('p', { className: CLASS.status, 'data-kind': status.kind, role: status.kind === 'error' ? 'alert' : 'status' }, status.text),
        )
      }
    }

    // -----------------------------------------------------------------------
    // Entry.
    // -----------------------------------------------------------------------

    /** Required browser services: the slot registry and the locale registry. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the three seat components.
     * @param ctx client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-siyuan-sender: dictionaries')
      const t = ctx.locale.bind(NS)

      // Delivered-file card. `conversation.chat.turnTail` declares this child
      // list, so a fresh id adds our cell beside the shipped entries.
      ctx.effect(
        () =>
          ctx.slots.inject('deliverables.file.actions', () =>
            ctx.slots.register(
              { name: 'deliverables.file.actions', id: 'siyuan-send', order: 30, locale: NS },
              deliveryAction(t),
            ),
          ),
        'dsh-siyuan-sender: delivery actions',
      )

      // Document-preview toolbar.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.document.actions', () =>
            ctx.slots.register(
              { name: 'sidebar.right.tab.document.actions', id: 'siyuan-send', order: 30, locale: NS },
              previewAction(t),
            ),
          ),
        'dsh-siyuan-sender: preview actions',
      )

      // Settings page.
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'siyuan-sender', order: 70, locale: NS, label: () => t('settings.title') },
              settingsSection(t),
            ),
          ),
        'dsh-siyuan-sender: settings section',
      )
    }

    return { inject, apply }
  },
})
