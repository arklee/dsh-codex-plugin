import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { converse } from './conversation.js'

const namespace = 'modelOauth'
const packageName = '@arkli/dsh-model-oauth'
const json = { mode: 'src-json' }
function descriptor(method, options) {
  return { id: `${packageName}#${namespace}/${method}`, service: namespace, namespace, method,
    invocation: { kind: 'direct' }, parameters: [], result: json, ...options }
}

// Explicit local descriptors: no source-parameter reflection, decorators or compiler step.
const contribution = {
  package: packageName, face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
  invocations: [descriptor('list'), descriptor('begin', {
    mode: 'stream', cancellation: { parameter: 'signal' }, uplink: { codec: json },
    parameters: ['key', 'method'].map(name => ({ name, wire: name, source: 'json', codec: json })),
  })],
}

function owner(ctx) {
  const invocation = ctx.invocation
  if (invocation?.peer?.principal?.kind !== 'owner') {
    throw new RemoteError('authorization/owner-required', 'Sign-in requires an authenticated owner.', {})
  }
  return invocation
}

const overrides = ['baseURL', 'api', 'apiKeyEnv']
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function eligibleRoutes(settings) {
  if (!settings) return () => true
  try {
    // DSH's stock entry id is llm-pi-ai. value is effective Config, base the
    // inherited Config, user the profile override. Inspect field presence,
    // never copy a header map, resolve an env ref, or expose the descriptor.
    const row = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    if (!record(row?.value)) return () => false
    const layers = [row.value, row.base, row.user].filter(layer => layer !== undefined)
    return provider => layers.every(layer => {
      if (!record(layer)) return false
      if (!Object.hasOwn(layer, 'providers')) return true
      const providers = layer.providers
      if (!record(providers)) return false
      if (!Object.hasOwn(providers, provider)) return true
      const profile = providers[provider]
      if (!record(profile) || overrides.some(field => Object.hasOwn(profile, field))) return false
      // A defaulted empty headers dictionary changes no request. Reject
      // nonempty/custom dictionaries without reading a single header value.
      const headers = Object.getOwnPropertyDescriptor(profile, 'headers')
      return !headers || (record(headers.value) && Object.keys(headers.value).length === 0)
    })
  } catch {
    throw new RemoteError('authorization/failed', 'Cannot verify the current model route settings.', {})
  }
}

function flows(authorization, settings) {
  // DSH CredentialKey is <scope>/<id>. Never expose account/connector flows or API-key methods.
  const candidates = (authorization?.list() ?? []).filter(({ key }) => key.startsWith('llm-pi-ai/'))
    .map(({ key, label, methods, inFlight }) => ({ key, label, inFlight,
      methods: methods.filter(({ id }) => id === 'oauth').map(({ id, label }) => ({ id, label })),
    })).filter(({ methods }) => methods.length)
  if (!candidates.length) return []
  const eligible = eligibleRoutes(settings)
  return candidates.filter(({ key }) => eligible(key.slice('llm-pi-ai/'.length)))
}

export default class ModelOauth extends TypertRemoteService {
  static inject = ['typert']

  constructor(ctx) {
    super(ctx, namespace)
    this.lifetime = new AbortController()
    ctx.effect(() => () => this.lifetime.abort())
    ctx.typert.register(contribution)
  }

  async list() {
    owner(this.ctx)
    const entries = flows(this.ctx.get('authorization'), this.ctx.get('settings'))
    if (!entries.length) return []
    try {
      const stored = await this.ctx.get('credentials').listRecords()
      const kinds = new Map(stored.map(({ key, kind }) => [key, kind]))
      return entries.map(entry => ({ ...entry, configured: kinds.has(entry.key),
        ...(kinds.has(entry.key) ? { recordKind: kinds.get(entry.key) } : {}),
      }))
    } catch {
      throw new RemoteError('authorization/failed', 'Cannot read saved sign-in status. Check credential storage and retry.', {})
    }
  }

  begin(key, method, signal) {
    const invocation = owner(this.ctx)
    const authorization = this.ctx.get('authorization')
    if (method !== 'oauth' || !flows(authorization, this.ctx.get('settings')).some(flow => flow.key === key)) {
      throw new RemoteError('gateway/bad-request', 'This sign-in method is not available.', {})
    }
    return converse(authorization, key, method, invocation.uplink(), AbortSignal.any([signal, this.lifetime.signal]))
  }
}
