import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createPlugin, parseArguments } from '../scripts/create-plugin.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'dsh-scaffold-test-'));
  t.after(async () => {
    // Check the exact resolved deletion target, never remove a computed unchecked path.
    const target = resolve(root);
    assert.ok(target.startsWith(`${parent}${sep}dsh-scaffold-test-`));
    assert.equal(await realpath(target), target);
    await rm(target, { recursive: true, force: true });
  });
  return root;
}

test('creates an honest disabled Host package without changing suite configuration', async (t) => {
  const root = await fixture(t);
  const suite = '{"sentinel":true}\n';
  await writeFile(join(root, 'suite.config.json'), suite);
  const result = await createPlugin({ root, slug: 'my-feature', scope: '@example' });
  assert.equal(result.packageName, '@example/dsh-my-feature');
  assert.equal(result.rowId, 'example.my-feature');
  assert.equal(result.directory, join(root, 'packages', 'my-feature'));
  const manifest = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.3-alpha.2');
  assert.equal(manifest.exports['.'].import, './dist/index.js');
  assert.equal(manifest.scripts.build, 'tsc -p tsconfig.json');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.dsh.client, undefined);
  assert.match(await readFile(join(result.directory, 'cordis.patch.yml'), 'utf8'), /disabled: true/);
  assert.match(await readFile(join(result.directory, 'src/index.ts'), 'utf8'), /export function apply\(\): void/);
  for (const lang of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(join(result.directory, 'locale', `${lang}.json`), 'utf8'));
    assert.ok(locale.meta.title && locale.meta.description);
  }
  assert.match(await readFile(join(result.directory, 'icon.svg'), 'utf8'), /viewBox="0 0 36 36"/);
  assert.match(await readFile(join(result.directory, 'README.md'), 'utf8'), /pnpm suite:generate/);
  assert.equal(JSON.parse(await readFile(join(result.directory, 'tsconfig.json'), 'utf8')).extends, '../../tsconfig.base.json');
  assert.equal(await readFile(join(root, 'suite.config.json'), 'utf8'), suite);
});

test('accepts an explicit bare scope and exact custom prerelease version', async (t) => {
  const root = await fixture(t);
  const result = await createPlugin({ root, slug: 'feature', scope: 'example', dshVersion: '1.2.3-rc.4+build.5' });
  const manifest = JSON.parse(await readFile(join(result.directory, 'package.json'), 'utf8'));
  assert.equal(manifest.engines.dsh, '1.2.3-rc.4+build.5');
});

test('rejects traversal, reserved names, invalid scopes and version injection before writing', async (t) => {
  const root = await fixture(t);
  for (const slug of ['../escape', '/tmp/escape', 'a/b', 'a\\b', '.', '', 'Upper', 'a--b', 'suite', 'shared', 'a'.repeat(81)]) {
    await assert.rejects(createPlugin({ root, slug, scope: 'example' }), /Invalid slug/);
  }
  for (const scope of ['', '../bad', '@bad/name', '@@bad', 'Upper', 'hello.world', 'bad\nname']) {
    await assert.rejects(createPlugin({ root, slug: 'feature', scope }), /scope/);
  }
  for (const dshVersion of [
    '^0.2.3', 'latest', '01.2.3', '1.2.3-01', '1.2.3\n', '1.2.3"', 'v1.2.3', '=1.2.3',
    '9007199254740992.2.3', '1.9007199254740992.3', '1.2.9007199254740992',
    `1.2.3-${'a'.repeat(256)}`,
  ]) {
    await assert.rejects(createPlugin({ root, slug: 'feature', scope: 'example', dshVersion }), /SemVer/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('refuses existing directory, file, and dangling symlink without altering content', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'packages'));
  await mkdir(join(root, 'packages', 'directory'));
  await writeFile(join(root, 'packages', 'directory', 'keep.txt'), 'keep');
  await writeFile(join(root, 'packages', 'file'), 'keep');
  await symlink(join(root, 'missing'), join(root, 'packages', 'link'));
  for (const slug of ['directory', 'file', 'link']) {
    await assert.rejects(createPlugin({ root, slug, scope: 'example' }), /Refusing to overwrite/);
  }
  assert.equal(await readFile(join(root, 'packages', 'directory', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(root, 'packages', 'file'), 'utf8'), 'keep');
});

test('rejects a symlinked packages directory pointing outside the repository', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, join(root, 'packages'));
  await assert.rejects(createPlugin({ root, slug: 'feature', scope: 'example' }), /Unsafe packages path/);
  assert.deepEqual(await readdir(outside), []);
});

test('rejects a symlinked packages directory pointing inside the repository', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'actual-packages'));
  await symlink(join(root, 'actual-packages'), join(root, 'packages'));
  await assert.rejects(createPlugin({ root, slug: 'feature', scope: 'example' }), /Unsafe packages path/);
  assert.deepEqual(await readdir(join(root, 'actual-packages')), []);
});

test('CLI requires explicit scope and rejects unknown, duplicate, or missing options', () => {
  assert.deepEqual(parseArguments(['feature', '--scope', '@example']), { slug: 'feature', scope: '@example' });
  assert.deepEqual(parseArguments(['feature', '--dsh-version', '1.2.3', '--scope', 'example']), { slug: 'feature', scope: 'example', dshVersion: '1.2.3' });
  for (const args of [[], ['feature'], ['feature', '--scope'], ['feature', '--root', '/tmp'], ['feature', '--scope', 'one', '--scope', 'two'], ['feature', '--scope', '--dsh-version']]) {
    assert.throws(() => parseArguments(args));
  }
});
