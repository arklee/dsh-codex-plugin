import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshPath } from '@deepseek-ai/dsh-home-paths'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Read or create the Harness home's OpenAI-only registration ID before pi-ai starts login.
 * @param signal - cancels the sign-in's wait for another process creating the ID.
 * @returns the persisted UUID, shared by OpenAI sign-ins from this home.
 */
export async function openaiDeviceId(signal: AbortSignal): Promise<string> {
  const path = dshPath('state', 'llm-pi-ai', 'openai-device-id')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  return withFileLock(path, async () => {
    let id: string
    try {
      id = (await readFile(path, 'utf8')).trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      id = randomUUID()
      await writeFileAtomic(path, `${id}\n`, { mode: 0o600 })
      return id
    }
    if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(id)) {
      throw new HarnessError('Invalid OpenAI device ID; restore or remove state/llm-pi-ai/openai-device-id and sign in again.', 'INVALID_OPENAI_DEVICE_ID')
    }
    return id
  }, { signal })
}
