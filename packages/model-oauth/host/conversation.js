import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

function projectPrompt({ kind, message, placeholder, options }) {
  if (kind !== 'select') return { kind, message, ...(placeholder === undefined ? {} : { placeholder }) }
  return { kind, message, options: options.map(({ id, label, description }) => ({
    id, label, ...(description === undefined ? {} : { description }),
  })) }
}

function noticeFrame({ message, url, code }) {
  const link = typeof url === 'string' ? URL.parse(url) : undefined
  return { kind: 'notice', notice: { message,
    ...(['https:', 'http:'].includes(link?.protocol) ? { url } : {}),
    ...(code === undefined ? {} : { code }),
  } }
}

// One attempt owns both halves of one logical stream. No browser-accessible
// session table, credential contents, or replies shared between connections.
export async function* converse(service, key, method, answers, signal) {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  const waiting = new Map()
  const queue = []
  let wake = Promise.withResolvers()
  let serial = 0, finished = false, failed = false, uplinkClosed = false

  function fail() {
    failed = true
    lifetime.abort()
  }
  function push(frame) {
    if (active.aborted || finished) return
    if (queue.length >= 256) return fail()
    queue.push(frame)
    wake.resolve()
  }
  async function consume() {
    for await (const answer of answers) {
      if (active.aborted || finished) break
      if (!Number.isSafeInteger(answer?.id) || typeof answer.value !== 'string') return fail()
      waiting.get(answer.id)?.(answer.value)
    }
    uplinkClosed = true
    if (waiting.size) lifetime.abort()
  }
  async function prompt(question) {
    const view = projectPrompt(question)
    const promptSignal = question.signal ? AbortSignal.any([active, question.signal]) : active
    promptSignal.throwIfAborted()
    if (uplinkClosed) throw new Error('Authorization reply channel is closed.')
    const id = ++serial
    const answer = Promise.withResolvers()
    function withdraw() {
      if (!waiting.delete(id)) return
      push({ kind: 'withdraw', id })
      answer.reject(new Error('Authorization prompt withdrawn.'))
    }
    waiting.set(id, value => { waiting.delete(id); answer.resolve(value) })
    promptSignal.addEventListener('abort', withdraw, { once: true })
    push({ kind: 'prompt', id, prompt: view })
    try { return await answer.promise } finally {
      waiting.delete(id)
      promptSignal.removeEventListener('abort', withdraw)
    }
  }

  void consume().catch(fail)
  const attempt = (async () => {
    try {
      const { status } = await service.begin({ key, method, signal: active,
        interaction: { prompt, notify: notice => push(noticeFrame(notice)) },
      })
      if (!signal.aborted && !failed) queue.push({ kind: 'done', status })
    } catch { failed = true } finally { finished = true; wake.resolve() }
  })()
  try {
    while (!finished || queue.length) {
      if (queue.length) { yield queue.shift(); continue }
      await wake.promise
      wake = Promise.withResolvers()
    }
    if (failed) throw new RemoteError('authorization/failed', 'Sign-in failed. Start a new sign-in to retry.', {})
  } finally {
    lifetime.abort()
    await attempt
    // Gateway owns the uplink iterator; completing the downlink releases its pending read.
  }
}
