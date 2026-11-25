import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { CredentialProvider, credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import * as Adapter from '@arkli/dsh-model-oauth-adapter'

/** In-memory records for registration and interactive API-key login, without ambient secrets. */
class MemoryCredentials extends CredentialProvider {
  records = new Map<CredentialKey, CredentialRecord>()
  async resolve() { return undefined }
  async describe(): Promise<never> { throw new Error('Reference lookup is not used') }
  async set(): Promise<never> { throw new Error('Reference writes are not used') }
  async unset(): Promise<never> { throw new Error('Reference writes are not used') }
  async readRecord(key: CredentialKey) { return this.records.get(key) }
  async describeRecord(key: CredentialKey) {
    const record = this.records.get(key)
    return { configured: record !== undefined, writable: true, kind: record?.kind }
  }
  async listRecords() {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const record = await mutate(this.records.get(key))
    if (record !== undefined) {
      this.records.set(key, record)
      this.notifyRecordUpdated(key)
    }
    return this.records.get(key)
  }
  async deleteRecord(key: CredentialKey) { this.records.delete(key) }
}

test('catalog and OAuth registrations are withdrawn on unload and restored once on reload', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    let baseline: ReturnType<typeof ctx.authorization.list> | undefined
    let directory: ReturnType<typeof ctx.llm.listConfigurableProviders> | undefined
    for (let cycle = 0; cycle < 2; cycle++) {
      const mounted = await ctx.plugin(Adapter, { providers: { openai: {} } })
      const flows = ctx.authorization.list()
      const providers = ctx.llm.listConfigurableProviders()
      assert.ok(providers.length > 10)
      assert.equal(new Set(providers.map(entry => entry.provider)).size, providers.length)
      assert.equal(new Set(flows.map(entry => entry.key)).size, flows.length)
      assert.deepEqual(flows.find(entry => entry.key === credentialKey('llm-pi-ai', 'openai'))?.methods.map(method => method.id), ['oauth', 'api-key'])
      assert.deepEqual(flows.find(entry => entry.key === credentialKey('llm-pi-ai', 'openai-codex'))?.methods.map(method => method.id), ['oauth'])
      assert.deepEqual(flows.find(entry => entry.key === credentialKey('llm-pi-ai', 'deepseek'))?.methods.map(method => method.id), ['api-key'])
      assert.equal(providers.find(entry => entry.provider === 'openai')?.nativeAuth?.oauth, true)
      assert.deepEqual(ctx.llm.listProviders().map(entry => entry.id), ['openai'])
      if (baseline) assert.deepEqual(flows, baseline)
      if (directory) assert.deepEqual(providers, directory)
      const key = credentialKey('llm-pi-ai', 'deepseek')
      const prompts: string[] = []
      assert.deepEqual(await ctx.authorization.begin({
        key, method: 'api-key',
        interaction: {
          notify() {},
          async prompt(prompt) {
            prompts.push(prompt.kind)
            return 'fixture-login-key'
          },
        },
      }), { status: 'authorized' })
      assert.deepEqual(prompts, ['secret'])
      assert.deepEqual(await ctx.credentials.readRecord(key), { kind: 'api-key', key: 'fixture-login-key' })
      baseline = flows
      directory = providers
      await mounted.dispose()
      assert.deepEqual(ctx.authorization.list(), [])
      assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
      assert.deepEqual(ctx.llm.listProviders(), [])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('built adapter streams a local HTTP reply through LlmRuntime', async () => {
  const requests: { path: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()) })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const choice of [
      { index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' },
    ]) response.write('data: ' + JSON.stringify({ id: 'local', object: 'chat.completion.chunk',
      created: 1, model: 'fixture-model', choices: [choice] }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  const ctx = new Context()
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: { FIXTURE_API_KEY: 'local-only-key' } },
    ]))
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Adapter, { providers: { fixture: {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: 'FIXTURE_API_KEY', models: [{ id: 'fixture-model' }],
    } } })
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({ provider: 'fixture', model: 'fixture-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }] })],
    })) assembler.push(chunk)
    assert.deepEqual(assembler.finish, { kind: 'stop' })
    assert.deepEqual(assembler.message({ provider: 'fixture', model: 'fixture-model' }).content,
      [{ type: 'text', text: 'hello' }])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/v1/chat/completions')
    assert.equal(requests[0].authorization, 'Bearer local-only-key')
    assert.equal(requests[0].body.model, 'fixture-model')
    assert.equal(requests[0].body.stream, true)
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }
})
