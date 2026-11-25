/** Built-artifact bootstrap checks; visual rendering remains an application-level check. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const authorizationRequire = createRequire(import.meta.resolve('@arkli/dsh-model-oauth-authorization/remote'))
const zod = authorizationRequire('zod')
const artifact = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')

function load() {
  let manifest
  runInNewContext(artifact, { window: { __ModuleLoader__: { load(value) { manifest = value } } } })
  assert.equal(manifest.id, '@arkli/dsh-model-oauth-ui')
  const entry = manifest.factory(id => id === 'zod' ? zod : {})
  return { manifest, entry }
}

test('mounts authorization before activating its dependent UI scope', async () => {
  const { manifest, entry } = load()
  assert.ok(!entry.inject.includes('remote.authorization'))
  assert.ok(entry.inject.includes('remote'))
  let completeMount
  const mounted = new Promise(resolve => { completeMount = resolve })
  const events = []
  const pending = entry.apply({
    remote: { async $mount(contribution) {
      assert.equal(contribution.package, '@arkli/dsh-model-oauth-authorization')
      events.push('mount')
      await mounted
    } },
    inject(names, callback) {
      assert.deepEqual([...names], ['remote.authorization'])
      assert.equal(typeof callback, 'function')
      events.push('inject')
    },
  }, {})
  assert.deepEqual(events, ['mount'])
  completeMount()
  await pending
  assert.deepEqual(events, ['mount', 'inject'])
  const sheets = Object.values(manifest.meta().stylesheets)
  assert.equal(sheets.length, 4)
  for (const sheet of sheets) assert.ok(sheet.text().length > 0)
})

test('does not register the UI when mounting authorization fails', async () => {
  const { entry } = load()
  const failure = new Error('mount refused')
  await assert.rejects(entry.apply({
    remote: { async $mount() { throw failure } },
    inject() { assert.fail('UI registered without authorization') },
  }, {}), error => error === failure)
})
