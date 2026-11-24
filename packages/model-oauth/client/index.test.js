import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as zod from 'zod'

const source = await readFile(new URL('index.js', import.meta.url), 'utf8')
function plugin() {
  let manifest
  new Function('window', source)({ __ModuleLoader__: { load: value => { manifest = value } } })
  assert.equal(manifest.id, '@arkli/dsh-model-oauth')
  return manifest.factory(name => {
    if (name === 'react') return {} // Slot registration is exercised without rendering a DOM.
    if (name === 'zod') return zod
    assert.fail(`Unexpected external: ${name}`)
  })
}

const key = 'llm-pi-ai/example'
const flow = { key, label: 'Example', methods: [{ id: 'oauth', label: 'OAuth' }], configured: false, inFlight: false }

// Use the official Client Gateway and Typert registry, not a pre-existing
// remote.modelOauth mock: misspelled namespaces/arguments must fail this test.
async function mount(t, open, call = async () => ({ ok: true, value: [flow] })) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', { interactions: 'none', rpc: { call, open } })
  ctx.provide('locale', { register: () => () => {}, bind: () => key => key })
  const registration = Promise.withResolvers()
  ctx.provide('slots', { inject: (_, register) => register(), register: spec => registration.resolve(spec) })
  await ctx.plugin(gateway)
  const owner = ctx.plugin(plugin())
  await owner
  const spec = await registration.promise
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'arkli-model-oauth')
  return { operations: spec.inject().operations, owner, ctx }
}

test('mounts stock Gateway projection, lists only OAuth methods, and withdraws on disable', async t => {
  const { operations, owner, ctx } = await mount(t, () => assert.fail(), async (base, endpoint, payload) => {
    assert.equal(base, '/api'); assert.equal(endpoint, 'modelOauth/list')
    assert.deepEqual({ ...payload.args }, {})
    return { ok: true, value: [flow, { ...flow, methods: [{ id: 'api-key', label: 'API key' }] }] }
  })
  assert.deepEqual(await operations.list(), [flow])
  await owner.dispose()
  assert.equal(ctx.typert.remotes.get('modelOauth/list'), undefined)
})

test('private stream keeps only safe links, ignores withdrawn answers, sends on same stream, and clears transient data', async t => {
  const replies = []
  const { operations } = await mount(t, async function* (base, endpoint, { args }, signal, uplink) {
    assert.equal(base, '/api'); assert.equal(endpoint, 'modelOauth/begin')
    assert.deepEqual({ ...args }, { key, method: 'oauth' })
    for (const url of ['javascript:alert(1)', 'https://name:pass@example.com/', 'http://example.com/']) {
      yield { kind: 'notice', notice: { url, message: 'unsafe' } }
    }
    yield { kind: 'notice', notice: { url: 'https://example.com/verify', code: 'sample', message: 'verify' } }
    yield { kind: 'prompt', id: 1, prompt: { kind: 'secret', message: 'First' } }
    yield { kind: 'withdraw', id: 1 }
    yield { kind: 'prompt', id: 2, prompt: { kind: 'select', message: 'Second', options: [{ id: 'a', label: 'A' }] } }
    replies.push((await uplink[Symbol.asyncIterator]().next()).value)
    yield { kind: 'done', status: 'authorized' }
  })
  let stale, latest
  const session = operations.conversation(state => {
    latest = state
    for (const n of state.notices ?? []) {
      if (n.message === 'unsafe') assert.equal(n.url, undefined)
      else assert.equal(n.url, 'https://example.com/verify')
    }
    const q = state.questions?.[0]
    if (q?.id === 1) stale = q.answer
    if (q?.id === 2) { stale('obsolete'); q.answer('a') }
  })
  await session.start(key)
  assert.deepEqual(replies, [{ id: 2, value: 'a' }])
  assert.deepEqual(latest, { status: 'authorized' })
})

test('cancel aborts the generation, ignores late completion, and unexpected EOF fails', async t => {
  let starts = 0, signal
  const waiting = Promise.withResolvers()
  const { operations } = await mount(t, async function* (_, __, ___, active) {
    if (++starts > 1) return
    signal = active
    yield { kind: 'prompt', id: 1, prompt: { kind: 'text', message: 'Code' } }
    await waiting.promise
    yield { kind: 'done', status: 'authorized' }
  })
  const received = Promise.withResolvers()
  let latest
  const session = operations.conversation(s => { latest = s; if (s.questions?.length) received.resolve() })
  const done = session.start(key)
  await received.promise
  await session.start(key) // Double-click does not open another stream.
  session.cancel()
  assert.equal(signal.aborted, true)
  waiting.resolve(); await done
  assert.deepEqual(latest, { status: 'cancelled' })
  await session.start(key)
  assert.deepEqual(latest, { status: 'failed' })
})

test('disabling the plugin aborts even an active stream via the owned mount', async t => {
  const started = Promise.withResolvers()
  const { operations, owner } = await mount(t, async function* (_, __, ___, signal) {
    started.resolve(signal)
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  let latest
  const done = operations.conversation(state => { latest = state }).start(key)
  const signal = await started.promise
  await owner.dispose()
  assert.equal(signal.aborted, true)
  await done
  assert.notEqual(latest.status, 'authorized')
})
