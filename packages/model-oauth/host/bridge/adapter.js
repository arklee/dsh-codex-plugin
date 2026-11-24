// Adapted from DeepSeek Harness ed77a65860 (MIT; see LICENSE.deepseek).
import { attributionHeaders, contentHasImage, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { requestImageTarget, toPiContext } from './context.js'
import { resolveImageRequestBudget } from './image-policy.js'
import { conversationUpdates, getSupportedThinkingLevels } from './models.js'
import { toStreamChunks } from './stream.js'

const imageLimits = { maxRequestImageBytes: 20 * 1024 * 1024, maxRequestImages: 50,
  imageOffloadCountQuantum: 10, requestImageBudgetCount: 20, requestImagePixelBudget: 2048 * 2048 }

// There is only one immutable, catalog-owned endpoint. Keep the external DSH
// route on all public model metadata; pi-ai owns 'openai' on its side only.
export class OpenAIAdapter extends LlmAdapter {
  constructor(ctx, models, credentials, lifetime) {
    super()
    Object.assign(this, { ctx, models, credentials, lifetime })
  }
  providerInfo(id) { return { id, name: 'OpenAI (ChatGPT)' } }
  async listModels(provider) {
    if (!await this.credentials.read('openai')) return []
    return this.models.getModels('openai').map(m => ({ provider, id: m.id, name: m.name, inputModalities: [...m.input] }))
  }
  model(id) {
    const model = this.models.getModel('openai', id)
    if (!model) throw new LlmError('Unknown OpenAI chat model: ' + id, 'UNKNOWN_MODEL')
    if (new URL(model.baseUrl).origin !== 'https://api.openai.com') throw new LlmError('Unexpected OpenAI endpoint', 'INVALID_CONFIG')
    return model
  }
  async resolveModel(provider, id) {
    const model = this.model(id)
    return { provider, id, name: model.name, inputModalities: [...model.input], context: { contextWindow: model.contextWindow },
      ...model.reasoning ? { reasoning: { efforts: getSupportedThinkingLevels(model).map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) })) } } : {},
      ...conversationUpdates(model) }
  }
  imageRequestTarget(_, id, image) {
    return requestImageTarget(image, resolveImageRequestBudget(this.model(id), imageLimits))
  }
  async *stream(options) {
    this.lifetime.throwIfAborted()
    if (options.stop !== undefined) throw new LlmError('Stop sequences are not supported', 'UNSUPPORTED_OPTION')
    const model = this.model(options.model), effort = options.reasoningEffort
    if (effort !== undefined && !getSupportedThinkingLevels(model).includes(effort))
      throw new LlmError('Unsupported reasoning effort', 'UNSUPPORTED_REASONING_EFFORT')
    if (!await this.credentials.read('openai')) throw new LlmError('Sign in with ChatGPT first.', 'MISSING_CREDENTIAL')
    const consumer = new AbortController()
    const signal = AbortSignal.any([consumer.signal, this.lifetime, ...options.signal ? [options.signal] : []])
    const watchdog = idleWatchdog(signal, 300_000, 'LLM_STREAM_IDLE_TIMEOUT')
    let iterator
    try {
      let images
      if (options.messages.some(m => contentHasImage(m.content))) {
        const attachments = this.ctx.get('attachments')
        if (!model.input.includes('image') || !attachments) throw new LlmError('Image input is unavailable', 'UNSUPPORTED_CONTENT')
        images = { attachments, ...imageLimits, requestImagePolicy: resolveImageRequestBudget(model, imageLimits),
          resolveImageAccess: ref => resolveImageAttachmentAccess(attachments, path => this.ctx.get('fs')?.processPathFromHostPath(path), ref) }
      }
      const context = await toPiContext({ ...options, signal: watchdog.signal }, images, undefined,
        conversationUpdates(model).systemPromptUpdate === 'in-history')
      const events = this.models.streamSimple(model, context, {
        reasoning: effort === 'off' ? undefined : effort, temperature: options.temperature, maxTokens: options.maxTokens,
        sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
        maxRetries: 0, disableContinuation: true, headers: attributionHeaders(), signal: watchdog.signal,
      })
      iterator = toStreamChunks(events, model.contextWindow, signal, model.id)[Symbol.asyncIterator]()
      while (true) {
        const step = await watchdog.next(iterator)
        if (step.done) { iterator = undefined; return }
        yield step.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')) throw new LlmError('OpenAI stream timed out', 'TIMEOUT', { cause: error })
      if (signal.aborted) throw new LlmError('OpenAI request cancelled', 'ABORTED', { cause: error })
      throw error
    } finally {
      consumer.abort()
      void iterator?.return(undefined).catch(() => {})
      watchdog[Symbol.dispose]()
    }
  }
}
