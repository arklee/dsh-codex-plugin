import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Registry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Authorization from '@deepseek-ai/dsh-authorization'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import ModelOauth from './index.js'

const key = 'llm-pi-ai/example', method = 'oauth'
const methods = [{ id: method, label: 'Sign in', extra: 'not public' }, { id: 'api-key', label: 'API key' }]
const entry = { key, label: 'Example', inFlight: false, methods, extra: 'not public' }

async function setup(t, begin) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const peerLifetime = new AbortController()
  const peer = { signal: peerLifetime.signal, principal: { kind: 'owner' } }
  for (const name of ['remoteAccess', 'credentials', 'authorization']) ctx.provide(name)
  ctx.set('remoteAccess', { decide: () => ({ kind: 'allow' }) })
  ctx.set('authorization', { begin, list: () => [entry, { ...entry, key: 'mcp-client/other' },
    { ...entry, key: 'llm-pi-ai/api-only', methods: methods.slice(1) }] })
  ctx.set('credentials', { listRecords: async () => [{ key, kind: 'grant', payload: 'not public' }] })
  await ctx.plugin(Registry)
  await ctx.plugin(Gateway, {})
  const plugin = ctx.plugin(ModelOauth)
  await plugin
  const list = () => ctx.typertGateway.invoke({ namespace: 'modelOauth', method: 'list', args: {}, peer })
  const open = async (uplink, args = { key, method }) => (await ctx.typertGateway.wireStream.open(
    'modelOauth/begin', { args }, uplink, peer, new AbortController().signal,
  ))[Symbol.asyncIterator]()
  return { ctx, list, open, peer, peerLifetime, plugin }
}
function empty() { return (async function* () {})() }

test('stock authorization owns the flow and credential commit; host never returns the stored record', async t => {
  const ctx = new Context(), records = new Map()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('credentials')
  ctx.set('credentials', {
    async modifyRecord(key, mutate) {
      records.set(key, await mutate(records.get(key)))
      ctx.emit('credentials/record-updated', key)
    },
    async describeRecord(key) { return { configured: records.has(key) } },
    async listRecords() { return [...records].map(([key, { kind }]) => ({ key, kind })) },
  })
  for (const service of [Registry, RemoteAccess, Gateway, Authorization, ModelOauth]) await ctx.plugin(service, {})
  ctx.authorization.registerFlow({ key, label: 'Example', methods, async run(session) {
    await session.commit({ kind: 'grant', payload: { token: 'fixture-only' } })
  } })
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const namespace = 'modelOauth'
  const stream = await ctx.typertGateway.stream({ namespace, method: 'begin', args: { key, method }, peer })
  const frames = []
  for await (const frame of stream) frames.push(frame)
  assert.deepEqual(frames, [{ kind: 'done', status: 'authorized' }])
  assert.equal(records.get(key).payload.token, 'fixture-only')
  assert.deepEqual(await ctx.typertGateway.invoke({ namespace, method: 'list', args: {}, peer }), [
    { key, label: 'Example', inFlight: false, configured: true, recordKind: 'grant', methods: [{ id: method, label: 'Sign in' }] },
  ])
})

test('official Gateway dispatches modelOauth, filters model OAuth and enforces owner even if policy allows guest', async t => {
  const { ctx, list, open, peer, plugin } = await setup(t, () => assert.fail('must not start'))
  assert.deepEqual(await list(), [{ key, label: 'Example', inFlight: false, configured: true, recordKind: 'grant',
    methods: [{ id: method, label: 'Sign in' }] }])
  for (const args of [{ key: 'mcp-client/other', method }, { key, method: 'api-key' }, { key: 'llm-pi-ai/api-only', method }]) {
    await assert.rejects(open(empty(), args), { code: 'gateway/bad-request' })
  }
  peer.principal.kind = 'guest'
  await assert.rejects(list(), { code: 'authorization/owner-required' })
  await assert.rejects(open(empty()), { code: 'authorization/owner-required' })
  await assert.rejects(ctx.modelOauth.list(), { code: 'authorization/owner-required' })
  await plugin.dispose()
  assert.equal(ctx.typert.local.get('modelOauth/begin'), undefined)
})

test('stream projects notices, prompts and withdrawals and ignores stale replies', async t => {
  const withdraw = new AbortController(), reply = Promise.withResolvers()
  const { open } = await setup(t, async ({ interaction: { notify, prompt } }) => {
    notify({ message: 'Verify', url: 'https://example.org', code: '123', extra: 'not public' })
    notify({ message: 'Unsafe', url: 'javascript:alert(1)' })
    await assert.rejects(prompt({ kind: 'text', message: 'Code', signal: withdraw.signal }))
    assert.equal(await prompt({ kind: 'select', message: 'Choose', options: [{ id: 'yes', label: 'Yes', extra: 'private' }] }), 'yes')
    return { status: 'authorized', payload: 'not public' }
  })
  const stream = await open((async function* () {
    await reply.promise
    yield { id: 1, value: 'stale' }; yield { id: 2, value: 'yes' }
  })())
  const next = async () => (await stream.next()).value
  assert.deepEqual(await next(), { kind: 'notice', notice: { message: 'Verify', url: 'https://example.org', code: '123' } })
  assert.deepEqual(await next(), { kind: 'notice', notice: { message: 'Unsafe' } })
  assert.deepEqual(await next(), { kind: 'prompt', id: 1, prompt: { kind: 'text', message: 'Code' } })
  withdraw.abort()
  assert.deepEqual(await next(), { kind: 'withdraw', id: 1 })
  assert.deepEqual(await next(), { kind: 'prompt', id: 2, prompt: { kind: 'select', message: 'Choose', options: [{ id: 'yes', label: 'Yes' }] } })
  reply.resolve()
  assert.deepEqual(await next(), { kind: 'done', status: 'authorized' })
  assert.equal((await stream.next()).done, true)
})

test('redacted route eligibility is checked on both list and begin, including inherited config', async t => {
  const { ctx, list, open } = await setup(t, () => assert.fail('must not start'))
  const row = { ns: 'llm-pi-ai', base: { providers: {} }, value: { providers: {} }, user: {} }
  let rows = [row]
  ctx.provide('settings')
  ctx.set('settings', { describe(options) { assert.deepEqual(options, { redactSecrets: true }); return rows } })
  for (const field of ['baseURL', 'api', 'apiKeyEnv', 'headers']) {
    for (const layer of ['value', 'base', 'user']) {
      assert.equal((await list()).length, 1)
      const profile = Object.defineProperty({}, field, { get() { throw new Error('must not read the field value') } })
      row[layer].providers = { example: profile }
      await assert.rejects(open(empty()), { code: 'gateway/bad-request' })
      assert.deepEqual(await list(), [])
      row[layer].providers = {}
    }
  }
  row.value.providers = { unrelated: { apiKeyEnv: 'OTHER' }, example: { models: [] } }
  assert.equal((await list()).length, 1)
  row.value.providers.example.headers = {} // schema-defaulted and explicit {} are indistinguishable in effective Config
  assert.equal((await list()).length, 1)
  row.value.providers.example.headers = { 'X-Gateway': 'fixture' }
  assert.deepEqual(await list(), [])
  rows = [{ ...row, ns: 'not-the-stock-entry' }]
  assert.deepEqual(await list(), [])
  await assert.rejects(open(empty()), { code: 'gateway/bad-request' })
})

test('never forwards provider error contents', async t => {
  const { open } = await setup(t, async () => { throw new Error('credential material') })
  const stream = await open(empty())
  await assert.rejects(stream.next(), { code: 'authorization/failed', message: 'Sign-in failed. Start a new sign-in to retry.', details: {} })
})

for (const reason of ['disconnect', 'disable']) test(`${reason} cancels the attempt and its outstanding prompt`, async t => {
  const closed = Promise.withResolvers(), released = Promise.withResolvers()
  const { open, peerLifetime, plugin } = await setup(t, async ({ signal, interaction }) => {
    try { await interaction.prompt({ kind: 'secret', message: 'Code' }) }
    finally { released.resolve(signal.aborted) }
  })
  const stream = await open((async function* () { await closed.promise })())
  assert.equal((await stream.next()).value.kind, 'prompt')
  if (reason === 'disconnect') peerLifetime.abort(); else await plugin.dispose()
  assert.equal(await released.promise, true)
  closed.resolve()
  await stream.return()
})
