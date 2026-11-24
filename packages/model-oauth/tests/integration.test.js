import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import Authorization from '@deepseek-ai/dsh-authorization'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Registry from '@deepseek-ai/dsh-typert-registry'
import ModelOauth from '../host/index.js'

const key = 'llm-pi-ai/fixture'
const oauth = { id: 'oauth', label: 'Sign in' }
const args = { key, method: 'oauth' }

async function setup(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const records = new Map()
  ctx.provide('credentials', {
    async listRecords() { return Array.from(records, ([key, { kind }]) => ({ key, kind })) },
    async describeRecord(key) { return { configured: records.has(key) } },
    async modifyRecord(key, mutate) {
      const record = await mutate(records.get(key))
      records.set(key, record)
      ctx.emit('credentials/record-updated', key)
      return record
    },
  })
  for (const plugin of [Authorization, Registry, RemoteAccess, Connection, Gateway]) {
    await ctx.plugin(plugin).await()
  }
  const owner = new Connection.Peer(ctx, { principal: { kind: 'owner' } })
  const channel = ctx.connection.createSharedFetchHandler('/api')
  function rpc(method, args, peer = owner) {
    return channel.fetch(new Request(`http://fixture.invalid/api/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method, payload: { args } }),
    }), peer)
  }
  // Warm the gateway's negative endpoint lookup before the plugin is loaded.
  assert.equal((await rpc('modelOauth/list', {})).status, 404)
  const plugin = ctx.plugin(ModelOauth)
  await plugin.await()
  async function list(peer) {
    const res = await rpc('modelOauth/list', {}, peer)
    assert.equal(res.status, 200)
    return (await res.json()).result
  }
  function open(uplink, signal, peer = owner, payload = args) {
    // The in-process carrier uses the same stock dispatcher as the WebSocket mux.
    return ctx.typertGateway.wireStream.open('modelOauth/begin', { args: payload }, uplink, peer, signal)
  }
  return { ctx, records, plugin, rpc, list, open }
}

test('live Host gateway lists only model OAuth and commits a grant from a stream reply', { timeout: 5000 }, async t => {
  const { ctx, records, plugin, list, rpc, open } = await setup(t)
  const unused = async () => { assert.fail('unselected flow ran') }
  const apiKey = { id: 'api-key', label: 'API key' }
  ctx.authorization.registerFlow({ key: 'calendar/private', label: 'Calendar', methods: [oauth], run: unused })
  ctx.authorization.registerFlow({ key: 'llm-pi-ai/key-only', label: 'Key only', methods: [apiKey], run: unused })
  const record = { kind: 'grant', payload: { token: 'fixture-token' } }
  const question = { kind: 'secret', message: 'Paste the verification code' }
  const notice = { message: 'Visit the provider', url: 'https://fixture.invalid/verify', code: 'ABCD' }
  ctx.authorization.registerFlow({ key, label: 'Fixture', methods: [apiKey, oauth], async run(session) {
    assert.equal(session.method, 'oauth')
    session.notify(notice)
    assert.equal(await session.prompt(question), 'fixture-answer')
    await session.commit(record)
  } })
  const row = { key, label: 'Fixture', methods: [oauth], inFlight: false, configured: false }
  assert.deepEqual(await list(), { ok: true, value: [row] })
  const signal = AbortSignal.timeout(3000)
  const uplink = new PassThrough({ objectMode: true })
  t.after(() => { uplink.destroy() })
  // A stream cannot be invoked as a unary RPC (including by a guessed URL).
  assert.equal((await (await rpc('modelOauth/begin', args)).json()).result.error.code, 'gateway/signature-invalid')
  const stream = await open(uplink, signal)
  const down = stream[Symbol.asyncIterator]()
  assert.deepEqual((await down.next()).value, { kind: 'notice', notice })
  const { value: prompt } = await down.next()
  assert.deepEqual(prompt, { kind: 'prompt', id: prompt.id, prompt: question })
  assert.ok(Number.isSafeInteger(prompt.id))
  assert.deepEqual(await list(), { ok: true, value: [{ ...row, inFlight: true }] })
  uplink.write({ id: prompt.id, value: 'fixture-answer' })
  assert.deepEqual((await down.next()).value, { kind: 'done', status: 'authorized' })
  assert.equal((await down.next()).done, true)
  assert.deepEqual(records.get(key), record)
  assert.deepEqual(await list(), { ok: true, value: [{ ...row, configured: true, recordKind: 'grant' }] })
  await plugin.dispose()
  // Previously seen descriptors stay claimed, but can no longer be invoked.
  assert.equal((await list()).error.code, 'gateway/definition-unavailable')
})

test('Host rejects non-owner calls even with a policy grant, and releases a disconnected owner attempt', { timeout: 5000 }, async t => {
  const { ctx, records, list, open } = await setup(t)
  const delegate = new Connection.Peer(ctx, { principal: { kind: 'fixture' } })
  ctx.remoteAccess.registerPolicy('fixture', { bindings: () => [{ resource: { kind: 'global' },
    role: { name: 'fixture', resource: 'global', actions: ['modelOauth/list', 'modelOauth/begin'] },
  }] })
  let started = 0
  ctx.authorization.registerFlow({ key, label: 'Other fixture', methods: [oauth], async run(session) {
    started++
    await session.prompt({ kind: 'text', message: 'Enter code' })
    await session.commit({ kind: 'grant', payload: {} })
  } })
  const uplink = new PassThrough({ objectMode: true })
  t.after(() => { uplink.destroy() })
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])
  assert.equal((await list(delegate)).error.code, 'authorization/owner-required')
  await assert.rejects(open(uplink, signal, delegate), { code: 'authorization/owner-required' })
  await assert.rejects(open(uplink, signal, undefined, { key, method: 'api-key' }), { code: 'gateway/bad-request' })
  assert.equal(started, 0)
  const down = (await open(uplink, signal))[Symbol.asyncIterator]()
  assert.equal((await down.next()).value.kind, 'prompt')
  const settled = new Promise(resolve => ctx.once('authorization/settled', (key, status) => resolve({ key, status })))
  controller.abort()
  assert.deepEqual(await settled, { key, status: 'cancelled' })
  assert.equal(started, 1)
  assert.equal(records.size, 0)
  assert.equal((await list()).value[0].inFlight, false)
})
