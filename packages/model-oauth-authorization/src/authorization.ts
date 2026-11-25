/** Owner-only browser conversations for credential flows registered on the Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKeyScope, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationAnswer, AuthorizationFlowView, AuthorizationFrame, AuthorizationPromptView } from './types.ts'
import type {} from '@deepseek-ai/dsh-typert-registry'
import TYPERT_REMOTE from './remote.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelOAuthAuthorization: AuthorizationController
  }
}

function projectPrompt(prompt: AuthorizationPrompt): AuthorizationPromptView {
  const { kind, message } = prompt
  if (kind !== 'select') return { kind, message, ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } }
  return { kind, message, options: prompt.options.map(({ id, label, description }) =>
    ({ id, label, ...description === undefined ? {} : { description } })) }
}

/** A URL supplied by a flow may become a clickable link on the owner page. */
function browserLink(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const parsed = URL.parse(url)
  return parsed?.protocol === 'https:' || parsed?.protocol === 'http:' ? url : undefined
}

/** Account and connector flows have separate consent and callback controllers. */
function modelFlows(service: AuthorizationService | undefined) {
  return (service?.list() ?? []).filter(entry => credentialKeyScope(entry.key) === 'llm-pi-ai')
    .map(entry => ({ ...entry, methods: entry.methods.filter(method => method.id === 'oauth') }))
    .filter(entry => entry.methods.length > 0)
}

async function* converse(service: AuthorizationService, key: CredentialKey, method: string,
  answers: AsyncIterable<AuthorizationAnswer>, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  const waiting = new Map<number, (answer: string) => void>()
  const queue: AuthorizationFrame[] = []
  let wake = Promise.withResolvers<void>()
  let serial = 0
  let uplinkClosed = false
  const state = { finished: false, failed: false }
  const push = (frame: AuthorizationFrame): void => {
    if (active.aborted) return
    if (queue.length >= 256) { state.failed = true; lifetime.abort(); return }
    queue.push(frame)
    wake.resolve()
  }
  const consume = async (): Promise<void> => {
    for await (const { id, value } of answers) {
      if (active.aborted || state.finished) break
      waiting.get(id)?.(value)
    }
    uplinkClosed = true
    if (waiting.size > 0) lifetime.abort()
  }
  void consume().catch(() => { state.failed = true; lifetime.abort() })
  const attempt = service.begin({ key, method, signal: active, interaction: {
    notify: ({ message, url, code }) => {
      const link = browserLink(url)
      push({ kind: 'notice', notice: { message, ...link === undefined ? {} : { url: link }, ...code === undefined ? {} : { code } } })
    },
    prompt: async (prompt) => {
      const promptSignal = prompt.signal === undefined ? active : AbortSignal.any([active, prompt.signal])
      promptSignal.throwIfAborted()
      if (uplinkClosed) throw new Error('Authorization reply channel is closed.')
      const id = ++serial
      const response = Promise.withResolvers<string>()
      const withdraw = (): void => {
        waiting.delete(id)
        push({ kind: 'withdraw', id })
        response.reject(new Error('Authorization prompt withdrawn.'))
      }
      promptSignal.addEventListener('abort', withdraw, { once: true })
      waiting.set(id, (value) => { waiting.delete(id); response.resolve(value) })
      push({ kind: 'prompt', id, prompt: projectPrompt(prompt) })
      try { return await response.promise } finally {
        waiting.delete(id)
        promptSignal.removeEventListener('abort', withdraw)
      }
    },
  } }).then(({ status }) => { push({ kind: 'done', status }) }, () => { state.failed = true }).finally(() => {
    state.finished = true
    wake.resolve()
  })
  try {
    while (!state.finished || queue.length > 0) {
      const next = queue.shift()
      if (next !== undefined) { yield next; continue }
      await wake.promise
      wake = Promise.withResolvers<void>()
    }
    if (state.failed) throw new RemoteError('authorization/failed', 'Sign-in failed. Start a new sign-in to retry.', {})
  } finally {
    lifetime.abort()
    await attempt
  }
}

/** Lists redacted flow metadata and binds one attempt to one bidirectional stream. */
export class AuthorizationController extends TypertRemoteService {
  static inject = ['typert']
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'modelOAuthAuthorization', { namespace: 'authorization' })
    ctx.effect(() => ctx.typert.remotes.register(TYPERT_REMOTE))
    ctx.effect(() => () => { this.lifetime.abort() })
  }

  private owner() {
    const invocation = this.ctx.invocation
    if (invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('authorization/owner-required', 'Sign-in requires an authenticated owner.', {})
    }
    return invocation
  }

  /**
   * List model sign-in methods available to an owner.
   * @returns registered OAuth flows and their redacted record status; empty when none is registered.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    this.owner()
    const entries = modelFlows(this.ctx.get('authorization'))
    if (!entries.length) return []
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new RemoteError('authorization/failed', 'Credential storage is unavailable.', {})
    const stored = await credentials.listRecords().catch(() => {
      throw new RemoteError('authorization/failed', 'Cannot read saved sign-in status. Check credential storage and retry.', {})
    })
    const records = new Map(stored.map(({ key, kind }) => [key, kind]))
    return entries.map(({ key, label, methods, inFlight }) => {
      const recordKind = records.get(key)
      return { key, label, methods: methods.map(method => ({ id: method.id, label: method.label })), inFlight,
        configured: recordKind !== undefined, ...recordKind === undefined ? {} : { recordKind } }
    })
  }

  /**
   * Run one model sign-in method for the initiating owner browser.
   * @param key - model credential key returned by `list()`.
   * @param method - OAuth method id offered for that key.
   * @param signal - stream lifetime; closing the stream withdraws the attempt and pending questions.
   * @returns notices, questions, withdrawals, and the final outcome; answers travel on the same stream.
   */
  @Remote({ mode: 'stream' })
  begin(key: string, method: string, signal: AbortSignal): RemoteStream<AuthorizationFrame, AuthorizationAnswer> {
    const invocation = this.owner()
    const service = this.ctx.get('authorization')
    const flow = modelFlows(service).find(entry => entry.key === key)
    if (service === undefined || flow === undefined || !flow.methods.some(candidate => candidate.id === method)) {
      throw new RemoteError('gateway/bad-request', 'This sign-in method is not available.', {})
    }
    return converse(service, flow.key, method, invocation.uplink<AuthorizationAnswer>(), AbortSignal.any([signal, this.lifetime.signal]))
  }
}
