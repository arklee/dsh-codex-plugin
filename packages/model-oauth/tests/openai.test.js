import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Authorization from '@deepseek-ai/dsh-authorization'
import LlmRuntime, { BlockAssembler, LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { grantKey, mountOpenAI, route } from '../host/openai.js'

test('stock registry: login enables Astra, refresh and tool continuation use only the isolated route', async t => {
  const home = await mkdtemp(join(tmpdir(), 'arkli-oauth-test-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    await rm(home, { recursive: true, force: true })
  })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let record
  ctx.provide('credentials', {
    async readRecord(key) { assert.equal(key, grantKey); return record },
    async describeRecord() { return { configured: !!record } },
    async modifyRecord(key, mutate) {
      assert.equal(key, grantKey); record = await mutate(record)
      ctx.emit('credentials/record-updated', key)
      return record
    },
  })
  await ctx.plugin(Authorization)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['openai'], new LlmAdapter())
  const ids = () => ctx.llm.listProviders().map(p => p.id).sort()
  const mount = () => ctx.plugin({ inject: ['authorization', 'credentials', 'llm'], apply: mountOpenAI })
  const plugin = mount(); await plugin
  assert.deepEqual(ids(), ['openai'])

  const model = 'gpt-6.2-astra'
  const requests = [], grants = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const req = new Request(url, init)
    if (req.url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const grant = new URLSearchParams(await req.text()).get('grant_type')
      grants.push(grant)
      return Response.json({ access_token: 'fixture-' + grant, refresh_token: 'fixture-refresh', id_token: 'fixture-id',
        scope: 'chatgpt.tokens.use.direct', expires_in: grant === 'refresh_token' ? 3600 : 1 })
    }
    assert.equal(req.url, 'https://api.openai.com/v1/responses')
    assert.equal(req.headers.get('authorization'), 'Bearer fixture-refresh_token')
    requests.push(await req.json())
    const item = requests.length === 1
      ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' }
      : { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] }
    const events = [{ type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }]
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  let callback
  const { status } = await ctx.authorization.begin({ key: grantKey, method: 'oauth', signal: AbortSignal.timeout(10_000),
    interaction: { notify({ url }) {
      if (!url) return
      const auth = new URL(url); assert.equal(auth.origin, 'https://auth.openai.com')
      callback = new URL(auth.searchParams.get('redirect_uri'))
      callback.search = new URLSearchParams({ code: 'fixture-code', client_id: 'fixture-client', state: auth.searchParams.get('state') })
    }, async prompt() { return callback.href } } })
  assert.equal(status, 'authorized')
  assert.deepEqual(ids(), [route, 'openai'])
  assert.ok((await ctx.llm.listModels(route)).some(m => m.provider === route && m.id === model))
  async function run(messages) {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: route, model, messages,
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }] })) assembler.push(chunk)
    return assembler.message({ provider: route, model, replayState: assembler.replayState })
  }
  const first = await run([])
  const call = first.content.find(b => b.type === 'tool-call')
  assert.equal(call.name, 'lookup')
  const second = await run([first, createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'ok' }] })])
  assert.ok(second.content.some(b => b.text === 'done'))
  assert.equal(requests[0].model, model)
  assert.ok(requests[1].input.some(i => i.type === 'function_call_output' && i.call_id === 'call_1'))
  assert.deepEqual(grants, ['authorization_code', 'refresh_token'])
  await plugin.dispose(); assert.deepEqual(ids(), ['openai'])
  await mount(); assert.deepEqual(ids(), [route, 'openai'])
  await ctx.credentials.modifyRecord(grantKey, () => undefined)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ids(), ['openai'])
})
