/** Portable RPC descriptors and browser-side authorization namespace augmentation. */
import type { RemoteResult, RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'
import type { AuthorizationAnswer, AuthorizationFlowView, AuthorizationFrame } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$617574686f72697a6174696f6e {
    begin: (key: string, method: string, signal?: AbortSignal) => RemoteStreamHandle<AuthorizationFrame, AuthorizationAnswer>
    list: () => Promise<RemoteResult<AuthorizationFlowView[]>>
  }
  interface TypertRemoteMap {
    'authorization/begin': (key: string, method: string, signal?: AbortSignal) => RemoteStreamHandle<AuthorizationFrame, AuthorizationAnswer>
    'authorization/list': () => Promise<RemoteResult<AuthorizationFlowView[]>>
  }
  interface TypertRemoteNamespaceMap {
    authorization: TypertRemoteNamespace$617574686f72697a6174696f6e
  }
}

const prompt = z.union([
  z.object({ kind: z.enum(['text', 'secret']), message: z.string(), placeholder: z.string().optional() }),
  z.object({ kind: z.literal('select'), message: z.string(), options: z.array(z.object({
    id: z.string(), label: z.string(), description: z.string().optional(),
  })) }),
])
const frame: z.ZodType<AuthorizationFrame> = z.union([
  z.object({ kind: z.literal('notice'), notice: z.object({ message: z.string(), url: z.string().optional(), code: z.string().optional() }) }),
  z.object({ kind: z.literal('prompt'), id: z.number(), prompt }),
  z.object({ kind: z.literal('withdraw'), id: z.number() }),
  z.object({ kind: z.literal('done'), status: z.enum(['authorized', 'cancelled']) }),
])
const answer: z.ZodType<AuthorizationAnswer> = z.object({ id: z.number(), value: z.string() })
const flows: z.ZodType<AuthorizationFlowView[]> = z.array(z.object({
  key: z.string(), label: z.string(), methods: z.array(z.object({ id: z.string(), label: z.string() })),
  inFlight: z.boolean(), configured: z.boolean(), recordKind: z.enum(['grant', 'api-key']).optional(),
}))
const stringCodec = { mode: 'strict', typeSymbol: 'string', create: () => z.string() } as const

/** Mount on the Host registry and the Client remote service for these two endpoints. */
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: '@arkli/dsh-model-oauth-authorization',
  methods: {
    'authorization/list': {
      service: 'modelOAuthAuthorization', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: 'AuthorizationFlowView[]', create: () => flows },
    },
    'authorization/begin': {
      service: 'modelOAuthAuthorization', invocation: { kind: 'direct' }, mode: 'stream',
      parameters: ['key', 'method'].map(name => ({ name, source: 'json' as const, codec: stringCodec, strictCodec: stringCodec })),
      cancellation: { parameter: 'signal' },
      uplink: { codec: { mode: 'strict', typeSymbol: 'AuthorizationAnswer', create: () => answer } },
      result: { mode: 'strict', typeSymbol: 'AuthorizationFrame', create: () => frame },
    },
  },
}, z)
export default TYPERT_REMOTE
