/** Browser-safe model authorization messages and redacted metadata. */
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Only an owner may inspect or run a flow. */
    'authorization/owner-required': {}
    /** Provider failures are redacted because they may contain credentials. */
    'authorization/failed': {}
  }
}

/** Metadata for a registered flow, without credential contents. */
export interface AuthorizationFlowView {
  key: string
  label: string
  methods: readonly { id: string; label: string }[]
  inFlight: boolean
  configured: boolean
  recordKind?: 'grant' | 'api-key'
}

/** A question on the initiating browser's private stream. */
export type AuthorizationPromptView =
  | { kind: 'text' | 'secret'; message: string; placeholder?: string }
  | { kind: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }

/** Stream-local question ids prevent a delayed answer from reaching a subsequent prompt. */
export type AuthorizationFrame =
  | { kind: 'notice'; notice: { message: string; url?: string; code?: string } }
  | { kind: 'prompt'; id: number; prompt: AuthorizationPromptView }
  | { kind: 'withdraw'; id: number }
  | { kind: 'done'; status: 'authorized' | 'cancelled' }

/** Answer to one pending prompt on the same stream. */
export interface AuthorizationAnswer {
  id: number
  value: string
}
