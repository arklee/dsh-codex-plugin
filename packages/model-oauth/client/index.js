// Directly served by DSH as a classic script (also safe in a combo script).
window.__ModuleLoader__.load({
  id: '@arkli/dsh-model-oauth',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const { z } = require('zod')
    const pkg = '@arkli/dsh-model-oauth'
    const ns = 'modelOauth'
    const codec = (name, create) => ({ mode: 'strict', typeSymbol: `${pkg}#${name}`, create })
    const option = () => z.object({ id: z.string(), label: z.string(), description: z.string().optional() })
    const flows = codec('flows', () => z.array(z.object({
      key: z.string(), label: z.string(), methods: z.array(option()), inFlight: z.boolean(),
      configured: z.boolean(), recordKind: z.enum(['grant', 'api-key']).optional(),
    })))
    const frame = codec('frame', () => z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('notice'), notice: z.object({ message: z.string(), url: z.string().optional(), code: z.string().optional() }) }),
      z.object({ kind: z.literal('prompt'), id: z.number(), prompt: z.union([
        z.object({ kind: z.enum(['text', 'secret']), message: z.string(), placeholder: z.string().optional() }),
        z.object({ kind: z.literal('select'), message: z.string(), options: z.array(option()) }),
      ]) }),
      z.object({ kind: z.literal('withdraw'), id: z.number() }),
      z.object({ kind: z.literal('done'), status: z.enum(['authorized', 'cancelled']) }),
    ]))
    const descriptor = (method, result, extra) => ({ id: `${pkg}#${ns}/${method}`, namespace: ns, service: ns,
      method, invocation: { kind: 'direct' }, parameters: [], result, ...extra })
    const contribution = { package: pkg, descriptors: [descriptor('list', flows), descriptor('begin', frame, {
      mode: 'stream', cancellation: { parameter: 'signal' },
      parameters: ['key', 'method'].map(name => ({ name, wire: name, source: 'json', codec: codec(name, () => z.string()) })),
      uplink: { codec: codec('answer', () => z.object({ id: z.number(), value: z.string() })) },
    })] }

    const en = {
      title: 'Model sign-in', intro: 'Sign in with a provider account. Stay on this page until sign-in finishes; leaving cancels the request.', warning: 'Use only trusted catalog endpoints. If you reuse a provider ID with a custom base URL, the stock adapter may send your OAuth credential there.',
      provider: 'Provider', empty: 'No model OAuth methods available.', loading: 'Loading providers…', listFailed: 'Cannot list providers. Check the owner connection and retry.',
      refresh: 'Refresh providers', signIn: 'Sign in', again: 'Sign in again', replace: 'Sign in and replace API key', savedKey: 'An API key is saved for this provider. Successful sign-in replaces it.', signedIn: 'This provider already has a saved OAuth grant.', inFlight: 'A sign-in is already in progress. Refresh after it finishes or after cancelling.', busy: 'Waiting for the provider. Follow the instructions below when they appear.',
      authorized: 'Grant saved. Configure or select the provider in Models.', cancelled: 'Sign-in cancelled.', failed: 'Sign-in failed. Start a new sign-in to retry.',
      open: 'Open verification page', submit: 'Continue', cancel: 'Cancel',
      openaiHint: 'Sign in to enable OpenAI (ChatGPT) in the chat model picker. No API key or provider setup is needed.',
      enabled: 'OpenAI (ChatGPT) is enabled. Choose a model in chat.',
      enable: 'Sign in and enable',
    }
    const zh = {
      title: '模型登录', intro: '使用服务商账号登录。完成前请停留在此页面；离开将取消本次登录。', warning: '请仅使用受信任的目录端点。如果复用服务商 ID 并设置自定义基础 URL，官方适配器可能会将 OAuth 凭据发送到该地址。',
      provider: '服务商', empty: '没有可用的模型 OAuth 登录方式。', loading: '正在读取服务商…', listFailed: '无法读取服务商。请检查所有者连接并重试。',
      refresh: '刷新服务商', signIn: '登录', again: '重新登录', replace: '登录并替换 API 密钥', savedKey: '此服务商已有保存的 API 密钥。登录成功后将替换该密钥。', signedIn: '此服务商已有保存的 OAuth 授权。', inFlight: '已有登录进行中。请在完成或取消后刷新状态。', busy: '正在等待服务商。若下方出现提示，请按提示继续。',
      authorized: '授权已保存。请在「模型」中配置或选择服务商。', cancelled: '登录已取消。', failed: '登录失败，请重新登录。',
      open: '打开验证页面', submit: '继续', cancel: '取消',
      openaiHint: '登录后即可在聊天模型列表中选择 OpenAI (ChatGPT)，无需填写 API Key 或另行添加提供商。',
      enabled: '已启用 OpenAI (ChatGPT)，可在聊天框中选择模型。',
      enable: '登录并启用',
    }

    function safeLink(value) {
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && !url.username && !url.password) return url.href
      } catch { /* Malformed or relative provider link. */ }
    }

    // Private to the initiating component. A stale answer must not reach a newer
    // prompt or a different stream; closing the page never resumes a conversation.
    function conversation(remote, update) {
      let active, notices, questions
      const finish = (attempt, status) => {
        if (active !== attempt) return
        active = undefined
        attempt.controller.abort()
        attempt.handle?.dispose()
        notices = []; questions = []
        update({ status })
      }
      return {
        async start(key) {
          if (active) return
          const attempt = { controller: new AbortController() }
          active = attempt
          notices = []; questions = []
          const publish = () => update({ status: 'busy', notices, questions })
          publish()
          try {
            attempt.handle = remote.begin(key, 'oauth', attempt.controller.signal)
            const schema = frame.create()
            for await (const raw of attempt.handle) {
              if (active !== attempt) return
              const item = schema.parse(raw)
              if (item.kind === 'done') { finish(attempt, item.status); return }
              if (item.kind === 'notice') {
                const notice = { ...item.notice, url: safeLink(item.notice.url) }
                // Keep the verification link/code visible while progress messages arrive.
                notices = notice.url || notice.code ? [notice] : [...notices.filter(n => n.url || n.code), notice]
              } else {
                questions = questions.filter(q => q.id !== item.id)
                if (item.kind === 'prompt') questions.push({ ...item, answer(value) {
                  if (active !== attempt || !questions.some(q => q.id === item.id)) return
                  try { attempt.handle.send({ id: item.id, value }) } catch { finish(attempt, 'failed'); return }
                  questions = questions.filter(q => q.id !== item.id); publish()
                } })
              }
              publish()
            }
          } catch { /* Never render carrier errors, provider responses, or answers. */ }
          finish(attempt, 'failed') // EOF without a terminal status is not success.
        },
        cancel() { if (active) finish(active, 'cancelled') },
      }
    }

    // Classic client entry: keep the stylesheet mounted with the section, and
    // use the same theme tokens and control sizes as DSH's Models settings.
    const sectionCss = `
      .arkli-model-oauth {
        display: grid; gap: 24px; max-width: 720px; min-width: 0;
        font-size: 14px; line-height: 22px; overflow-wrap: anywhere;
        color: var(--dsw-alias-label-primary);
      }
      .arkli-model-oauth h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
      .arkli-model-oauth header, .arkli-model-oauth label { display: grid; gap: 4px; }
      .arkli-model-oauth p { margin: 0; color: var(--dsw-alias-label-tertiary); }
      .arkli-model-oauth .card {
        display: grid; min-width: 0; gap: 12px; padding: 12px 14px;
        background: var(--dsw-alias-settings-card-fill);
        border: .5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl);
      }
      .arkli-model-oauth .warning, .arkli-model-oauth .saved {
        font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label);
      }
      .arkli-model-oauth .saved { color: var(--dsw-alias-state-success-primary); }
      .arkli-model-oauth [role="alert"] { color: var(--dsw-alias-state-error-primary); }
      .arkli-model-oauth .actions, .arkli-model-oauth form {
        display: flex; align-items: end; gap: 8px; flex-wrap: wrap;
      }
      .arkli-model-oauth label { min-width: 0; max-width: 100%; font-weight: 500; }
      .arkli-model-oauth :is(select, input, button) {
        box-sizing: border-box; max-width: 100%; border-radius: var(--dsw-radius-md);
        font: inherit; font-weight: 400; color: inherit;
      }
      .arkli-model-oauth :is(select, input) {
        width: 240px; height: 32px; padding: 0 10px;
        border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-1);
      }
      .arkli-model-oauth button {
        min-height: 36px; padding: 0 14px; cursor: pointer; background: transparent;
        border: .5px solid var(--dsw-alias-border-l3);
      }
      .arkli-model-oauth button.primary {
        background: var(--dsw-alias-button-primary-fill); border: 0; color: var(--dsw-alias-label-primary-foreground);
      }
      @media (hover: hover) {
        .arkli-model-oauth button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
        .arkli-model-oauth button.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      }
      .arkli-model-oauth :disabled { opacity: .6; cursor: default; }
      .arkli-model-oauth :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
      .arkli-model-oauth a { color: var(--dsw-alias-state-business-primary); }
    `

    function Answer({ question, t }) {
      const { prompt } = question
      const [value, change] = useState(prompt.kind === 'select' ? prompt.options[0]?.id ?? '' : '')
      const props = { value, onChange: event => change(event.target.value) }
      return h('form', {
        onSubmit: event => { event.preventDefault(); question.answer(value) } },
        h('label', null, prompt.message, ' ', prompt.kind === 'select'
          ? h('select', props, prompt.options.map(o => h('option', { key: o.id, value: o.id }, o.label)))
          : h('input', { ...props, autoComplete: 'off', type: prompt.kind === 'secret' ? 'password' : 'text', placeholder: prompt.placeholder })),
        h('button', { type: 'submit', className: 'primary' }, t('submit')))
    }

    function Section({ operations, t }) {
      // The slot renderer may render once before the injected face is ready.
      return operations && t ? h(SignIn, { operations, t }) : null
    }

    function SignIn({ operations, t }) {
      const [rows, setRows] = useState(null), [selected, select] = useState(''), [listError, setListError] = useState(false)
      const [revision, refresh] = useState(0), [session, setSession] = useState({})
      const current = useRef(null)
      useEffect(() => {
        let live = true
        const instance = operations.conversation(next => {
          if (!live) return
          setSession(next)
          if (next.status === 'authorized' || next.status === 'cancelled') refresh(v => v + 1)
        })
        current.current = instance
        return () => { live = false; instance.cancel(); current.current = null }
      }, [operations])
      useEffect(() => {
        let live = true
        setListError(false); setRows(null)
        operations.list().then(result => { if (live) setRows(result) }).catch(() => { if (live) setListError(true) })
        return () => { live = false }
      }, [operations, revision])
      const row = rows?.find(r => r.key === selected) ?? rows?.[0]
      const busy = session.status === 'busy'
      const own = row?.key === 'arkli-model-oauth/openai'
      return h('section', { className: 'arkli-model-oauth', 'aria-label': t('title') },
        h('style', null, sectionCss),
        h('header', null, h('h2', null, t('title')), h('p', null, t('intro'))),
        h('div', { className: 'card' },
        !row && h('p', { role: listError ? 'alert' : 'status' }, t(listError ? 'listFailed' : rows ? 'empty' : 'loading')),
        row && h('label', null, t('provider'), ' ', h('select', { disabled: busy, value: row.key, onChange: e => { select(e.target.value); setSession({}) } },
          rows.map(r => h('option', { key: r.key, value: r.key }, r.label)))),
        row?.recordKind === 'grant' && !(own && session.status === 'authorized') && h('p', { className: 'saved' }, t(own ? 'enabled' : 'signedIn')),
        row?.recordKind === 'api-key' && h('p', { className: 'warning' }, t('savedKey')),
        !(own && row.recordKind === 'grant') && h('p', { className: own ? undefined : 'warning' }, t(own ? 'openaiHint' : 'warning')),
        row?.inFlight && h('p', null, t('inFlight')),
        session.status && !(session.status === 'authorized' && !row) && h('p', { role: session.status === 'failed' ? 'alert' : 'status' }, t(own && session.status === 'authorized' ? 'enabled' : session.status)),
        busy && h('div', { 'aria-live': 'polite', 'aria-relevant': 'additions text' }, session.notices?.map((n, i) => h('p', { key: i }, n.message, ' ', n.code && h('code', null, n.code), ' ',
          n.url && h('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer' }, t('open'))))),
        session.questions?.map(q => h(Answer, { key: q.id, question: q, t })),
        h('div', { className: 'actions' }, busy
          ? h('button', { type: 'button', onClick: () => current.current.cancel() }, t('cancel'))
          : row && h('button', { className: 'primary', type: 'button', disabled: row.inFlight, onClick: () => current.current.start(row.key) }, t(row.recordKind === 'grant' ? 'again' : row.recordKind === 'api-key' ? 'replace' : own ? 'enable' : 'signIn')),
          !busy && h('button', { type: 'button', onClick: () => refresh(v => v + 1) }, t('refresh')))))
    }

    return { inject: ['remote', 'slots', 'locale'], async apply(ctx) {
      // Stock Gateway binds the mount to this calling fiber via ctx.effect;
      // fiber disposal withdraws descriptors and aborts all mounted methods.
      await ctx.remote.$mount(contribution)
      ctx.effect(() => ctx.locale.register(ns, { en, zh }), 'model-oauth: settings copy')
      const t = ctx.locale.bind(ns)
      ctx.inject(['remote.modelOauth'], scope => {
        const remote = scope.remote.modelOauth
        const operations = { conversation: update => conversation(remote, update), async list() {
          const result = await remote.list()
          if (!result.ok) throw new Error('List unavailable')
          return flows.create().parse(result.value).filter(flow => flow.methods.some(method => method.id === 'oauth'))
        } }
        scope.slots.inject('settings.section', () => scope.slots.register({ name: 'settings.section',
          id: 'arkli-model-oauth', order: 11, label: () => t('title'), inject: () => ({ operations, t }),
        }, Section))
      })
    } }
  },
});
