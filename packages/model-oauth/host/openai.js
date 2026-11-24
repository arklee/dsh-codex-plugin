import { createModels } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { OpenAIAdapter } from './bridge/adapter.js'
import { openaiDeviceId } from './bridge/openai-device-id.js'

export const route = 'arkli-openai'
export const grantKey = 'arkli-model-oauth/openai'

// pi-ai refreshes inside modify(); preserve DSH's cross-process exclusion and
// never import the official adapter's credentials or ambient OPENAI_API_KEY.
function credentialStore(service) {
  const unpack = record => record?.kind === 'grant' && record.payload?.type === 'oauth' ? record.payload : undefined
  return {
    async read(id) { return id === 'openai' ? unpack(await service.readRecord(grantKey)) : undefined },
    async list() { return await this.read('openai') ? [{ providerId: 'openai', type: 'oauth' }] : [] },
    async modify(id, mutate, options) {
      if (id !== 'openai') throw new Error('Unknown credential')
      return unpack(await service.modifyRecord(grantKey, async current => {
        options?.signal?.throwIfAborted()
        const next = await mutate(unpack(current))
        if (next === undefined) return undefined
        if (next.type !== 'oauth') throw new Error('Expected OAuth grant')
        return { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) }
      }))
    },
    async delete(id) { if (id === 'openai') await service.deleteRecord(grantKey) },
  }
}

function interaction(session) {
  return {
    signal: session.signal,
    notify(event) {
      if (event.type === 'device_code') session.notify({ message: 'Enter this code on the verification page.', url: event.verificationUri, code: event.userCode })
      else session.notify({ message: event.instructions ?? event.message ?? 'Open the verification page.',
        url: event.url ?? event.links?.[0]?.url })
    },
    prompt(prompt) {
      const kind = prompt.type === 'select' ? 'select' : ['manual_code', 'secret'].includes(prompt.type) ? 'secret' : 'text'
      return session.prompt({ kind, message: prompt.message, placeholder: prompt.placeholder, options: prompt.options, signal: prompt.signal })
    },
  }
}

export async function mountOpenAI(ctx) {
  const credentials = credentialStore(ctx.credentials)
  const auth = { credentials, authContext: { env: async () => undefined, fileExists: async () => false } }
  const native = openaiProvider()
  // The route accepts no endpoint, header, protocol or API-key overrides.
  const provider = { ...native, auth: { oauth: native.auth.oauth } }
  const login = createModels(auth)
  login.setProvider(provider)
  const lifetime = new AbortController()
  const adapter = new OpenAIAdapter(ctx, login, credentials, lifetime.signal)
  let handle, generation = 0, disposed = false, enabled = false
  async function sync() {
    const version = ++generation
    const signedIn = !!await credentials.read('openai')
    if (disposed || version !== generation || signedIn === enabled) return
    if (handle) handle.replace(signedIn ? [route] : [])
    else handle = ctx.llm.registerAdapter([route], adapter)
    enabled = signedIn
  }
  ctx.effect(() => () => { disposed = true; lifetime.abort() })
  ctx.on('credentials/record-updated', key => { if (key === grantKey) return sync() })
  ctx.authorization.registerFlow({
    key: grantKey, label: 'OpenAI (ChatGPT)', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    async run(session) {
      const id = await openaiDeviceId(session.signal)
      await login.login('openai', 'oauth', interaction(session), { agentName: 'DeepSeek Harness', getDeviceId: () => id })
      await sync()
    },
  })
  await sync()
}
