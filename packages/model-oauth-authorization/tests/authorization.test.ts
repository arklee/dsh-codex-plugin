import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Authorization, { type AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import Registry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ownerPeer, peerFor } from './peer.ts'
import { MemoryCredentials } from './memory.ts'
import AuthorizationController from '../dist/index.js'
import type { AuthorizationAnswer } from '../dist/types.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'sign-in-guest': { kind: 'sign-in-guest' }
  }
}

const key = credentialKey('llm-pi-ai', 'test')
const methods = [{ id: 'oauth', label: 'Sign in' }, { id: 'api-key', label: 'API key' }] as const

async function fixture(run: AuthorizationFlow['run']) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Registry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(Gateway, {})
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Authorization)
  const controller = ctx.plugin(AuthorizationController)
  await controller
  ctx.authorization.registerFlow({ key, label: 'Provider', methods, run })
  const peer = ownerPeer(ctx)
  const list = () => ctx.typertGateway.invoke({ namespace: 'authorization', method: 'list', args: {}, peer })
  const open = async (uplink: AsyncIterable<AuthorizationAnswer>, args = { key, method: 'oauth' }) =>
    (await ctx.typertGateway.stream({ namespace: 'authorization', method: 'begin', args, peer, uplink }))[Symbol.asyncIterator]()
  return { ctx, peer, list, open, controller }
}

it('delivers notices and withdrawn questions, accepts only the matching stream-local reply and lists no secret', async () => {
  const stale = new AbortController()
  const accepted = vi.fn<(value: string) => void>()
  const { open, list } = await fixture(async (session) => {
    session.notify({ message: 'Verify', url: 'https://login.example', code: '123' })
    await session.prompt({ kind: 'text', message: 'Manual callback', signal: stale.signal }).catch(() => undefined)
    const answer = await session.prompt({ kind: 'secret', message: 'Answer' })
    accepted(answer)
    await session.commit({ kind: 'grant', payload: { token: 'never returned' } })
  })
  const answered = Promise.withResolvers<undefined>()
  const close = Promise.withResolvers<undefined>()
  onTestFinished(() => { close.resolve(undefined) })
  async function* answers() {
    await answered.promise
    yield { id: 1, value: 'stale' }
    yield { id: 2, value: 'current' }
    await close.promise
  }
  const stream = await open(answers())
  expect(await stream.next()).toMatchObject({ value: { kind: 'notice', notice: { code: '123', url: 'https://login.example' } } })
  expect(await stream.next()).toMatchObject({ value: { kind: 'prompt', id: 1 } })
  stale.abort()
  expect(await stream.next()).toMatchObject({ value: { kind: 'withdraw', id: 1 } })
  expect(await stream.next()).toMatchObject({ value: { kind: 'prompt', id: 2, prompt: { kind: 'secret' } } })
  answered.resolve(undefined)
  expect(await stream.next()).toMatchObject({ value: { kind: 'done', status: 'authorized' } })
  close.resolve(undefined)
  expect(await stream.next()).toMatchObject({ done: true })
  expect(accepted.mock.calls).toEqual([['current']])
  expect(await list()).toEqual([{ key, label: 'Provider', methods: [methods[0]], configured: true, inFlight: false, recordKind: 'grant' }])
})

it('does not offer or run account, connector, or API-key methods, including for an owner', async () => {
  const run = vi.fn(async () => {})
  const { ctx, list, open } = await fixture(run)
  for (const scope of ['deepseek-account-platform', 'mcp-client']) {
    const other = credentialKey(scope, 'default')
    ctx.authorization.registerFlow({ key: other, label: scope, methods, run })
    await expect(open((async function* () {})(), { key: other, method: 'oauth' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  }
  await expect(open((async function* () {})(), { key, method: 'api-key' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  expect(await list()).toEqual([{ key, label: 'Provider', methods: [methods[0]], configured: false, inFlight: false }])
  expect(run).not.toHaveBeenCalled()
  await expect(ctx.modelOAuthAuthorization.list()).rejects.toMatchObject({ code: 'authorization/owner-required' })
  expect(() => ctx.modelOAuthAuthorization.begin(key, 'oauth', new AbortController().signal)).toThrow(expect.objectContaining({ code: 'authorization/owner-required' }))
})

it('refuses a guest even when a gateway access policy allows both endpoints', async () => {
  const run = vi.fn(async () => {})
  const { ctx } = await fixture(run)
  ctx.remoteAccess.registerPolicy('sign-in-guest', { bindings: () => [{ resource: { kind: 'global' },
    role: { name: 'guest', resource: 'global', actions: ['authorization/list', 'authorization/begin'] } }] })
  const peer = peerFor(ctx, { kind: 'sign-in-guest' })
  const request = { namespace: 'authorization', peer }
  await expect(ctx.typertGateway.invoke({ ...request, method: 'list', args: {} })).rejects.toMatchObject({ code: 'authorization/owner-required' })
  await expect(ctx.typertGateway.stream({ ...request, method: 'begin', args: { key, method: 'oauth' } })).rejects.toMatchObject({ code: 'authorization/owner-required' })
  expect(run).not.toHaveBeenCalled()
})

it('drops executable links and does not forward a provider error that includes secret material', async () => {
  const { open } = await fixture(async (session) => {
    session.notify({ message: 'Visit', url: 'javascript:alert(1)' })
    throw new Error('a provider error containing a secret')
  })
  const stream = await open((async function* () {})())
  expect(await stream.next()).toEqual({ done: false, value: { kind: 'notice', notice: { message: 'Visit' } } })
  await expect(stream.next()).rejects.toMatchObject({ code: 'authorization/failed', message: 'Sign-in failed. Start a new sign-in to retry.', details: {} })
})

it('releases the flow and its prompt when the initiating peer disconnects', async () => {
  const left = Promise.withResolvers<undefined>()
  const { ctx, open, peer } = await fixture(async (session) => {
    try { await session.prompt({ kind: 'text', message: 'Continue?' }) } finally { left.resolve(undefined) }
  })
  const close = Promise.withResolvers<undefined>()
  onTestFinished(() => { close.resolve(undefined) })
  const stream = await open((async function* () { await close.promise })())
  expect(await stream.next()).toMatchObject({ value: { kind: 'prompt' } })
  const disconnected = peer.dispose()
  await left.promise
  close.resolve(undefined)
  await disconnected
  expect(ctx.authorization.describe(key)?.inFlight).toBe(false)
})

it('aborts a pending question on plugin unload and remounts without duplicate endpoints', async () => {
  const left = Promise.withResolvers<void>()
  const { ctx, open, list, controller } = await fixture(async (session) => {
    try { await session.prompt({ kind: 'text', message: 'Continue?' }) } finally { left.resolve() }
  })
  const close = Promise.withResolvers<void>()
  onTestFinished(() => { close.resolve() })
  const stream = await open((async function* () { await close.promise })())
  expect(await stream.next()).toMatchObject({ value: { kind: 'prompt' } })
  await controller.dispose()
  await left.promise
  close.resolve()
  await stream.return?.()
  expect(ctx.authorization.describe(key)?.inFlight).toBe(false)
  expect(ctx.typert.remotes.get('authorization/list')).toBeUndefined()
  await ctx.plugin(AuthorizationController)
  expect(await list()).toEqual([{ key, label: 'Provider', methods: [methods[0]], configured: false, inFlight: false }])
})

it('withdraws malformed uplink answers without committing a credential', async () => {
  const { ctx, peer } = await fixture(async (session) => {
    await session.prompt({ kind: 'secret', message: 'Code' })
  })
  const uplink = (async function* () { yield { id: 'not-a-number', value: 'secret' } })()
  const stream = await ctx.typertGateway.stream({
    namespace: 'authorization', method: 'begin', args: { key, method: 'oauth' }, peer, uplink,
  })
  const frames = []
  for await (const frame of stream) frames.push(frame)
  expect(frames).not.toContainEqual({ kind: 'done', status: 'authorized' })
  expect(await ctx.credentials.readRecord(key)).toBeUndefined()
})

it('redacts storage failures when listing saved sign-in status', async () => {
  const { ctx, list } = await fixture(async () => {})
  vi.spyOn(ctx.credentials, 'listRecords').mockRejectedValue(new Error('secret storage detail'))
  await expect(list()).rejects.toMatchObject({
    code: 'authorization/failed',
    message: 'Cannot read saved sign-in status. Check credential storage and retry.',
  })
})
