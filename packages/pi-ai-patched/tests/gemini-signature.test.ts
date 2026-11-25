import assert from 'node:assert/strict'
import test from 'node:test'
import { stream } from '@arkli/pi-ai-patched/api/openai-completions'
import { normalizeContext } from '@arkli/pi-ai-patched/utils/transcript'
import type { Model, UserMessage } from '@arkli/pi-ai-patched'

const model: Model<'openai-completions'> = {
  id: 'gemini-test', name: 'Gemini test', provider: 'google',
  api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
  input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

for (const signature of ['signed-gemini-call', undefined, '', 42]) {
  test(`wire tool call preserves and replays a valid signature: ${String(signature)}`, async () => {
    const bodies: { messages: { role: string; tool_calls?: object[] }[] }[] = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'https://fixture.invalid/v1/chat/completions')
      assert.ok(typeof init?.body === 'string')
      bodies.push(JSON.parse(init.body))
      const delta = bodies.length === 1
        ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
            function: { name: 'count', arguments: '{"value":2}' },
            ...(signature === undefined ? {} : { extra_content: { google: { thought_signature: signature } } }),
          }] }
        : { content: 'two' }
      const event = { id: 'reply', object: 'chat.completion.chunk', created: 1,
        model: model.id, choices: [{ index: 0, delta, finish_reason: null }] }
      const finish = { ...event, choices: [{ index: 0, delta: {},
        finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] }
      return new Response([event, finish].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    }
    const tools = [{ name: 'count', description: 'Count', parameters: {
      type: 'object', properties: { value: { type: 'number' } },
    } }]
    const user: UserMessage = { role: 'user', content: 'count two', timestamp: 1 }
    const options = { apiKey: 'fixture-key', fetch }
    const call = await stream(model, normalizeContext({ tools, messages: [user] }), options).result()
    assert.equal(call.stopReason, 'toolUse', call.errorMessage)
    const block = call.content.find(block => block.type === 'toolCall')
    assert.ok(block)
    assert.deepEqual(block.arguments, { value: 2 })
    const expected = typeof signature === 'string' && signature.length > 0 ? signature : undefined
    assert.equal(block.thoughtSignature, expected)

    const answer = await stream(model, normalizeContext({ tools, messages: [user, call, {
      role: 'toolResult', toolCallId: block.id, toolName: 'count',
      content: [{ type: 'text', text: '2' }], isError: false, timestamp: 2,
    }] }), options).result()
    assert.equal(answer.stopReason, 'stop', answer.errorMessage)
    assert.ok(answer.content.some(block => block.type === 'text' && block.text === 'two'))
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1].messages.find(message => message.role === 'assistant')?.tool_calls, [{
      id: 'call_1', type: 'function', function: { name: 'count', arguments: '{"value":2}' },
      ...(expected === undefined ? {} : { extra_content: { google: { thought_signature: expected } } }),
    }])
  })
}
