import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validatePackage, checkPackages, tarFiles } from '../scripts/check-packages.ts';
import type { PackageFiles } from '../scripts/check-packages.ts';

function fixture(): PackageFiles {
  return new Map(Object.entries({
    'package.json': JSON.stringify({ name: '@fixture/dsh-demo', version: '0.1.0', type: 'module', engines: { dsh: '0.2.3-alpha.2' }, files: ['dist', 'locale', 'icon.svg', 'cordis.patch.yml'], exports: { '.': './dist/index.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: {} }),
    'dist/index.js': 'export function apply() {}',
    'cordis.patch.yml': '- insert:\n    - id: fixture.demo\n      name: "@fixture/dsh-demo"\n      disabled: true\n',
    'locale/en.json': '{"meta":{"title":"Demo scaffold","description":"Unimplemented scaffold."}}',
    'locale/zh.json': '{"meta":{"title":"开发骨架","description":"尚未实现业务。"}}',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'README.md': '# Scaffold',
  }).map(([path, text]) => [path, Buffer.from(text)]));
}
function change(files: PackageFiles, mutate: (manifest: any) => void): void {
  const manifest = JSON.parse(files.get('package.json')!.toString());
  mutate(manifest);
  files.set('package.json', Buffer.from(JSON.stringify(manifest)));
}

function ordinary(): PackageFiles {
  const files = fixture();
  for (const path of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg']) files.delete(path);
  files.set('dist/index.d.ts', Buffer.from('export declare function apply(): void;'));
  files.set('LICENSE', Buffer.from('MIT'));
  change(files, m => {
    delete m.dsh;
    delete m.engines;
    m.license = 'MIT';
    m.files = ['dist', 'LICENSE', 'README.md'];
    m.exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './modules/*': './dist/*.js' };
  });
  return files;
}

test('validates ordinary ESM packages without bundle metadata', () => {
  assert.equal(validatePackage(ordinary(), true).name, '@fixture/dsh-demo');
  const files = ordinary();
  change(files, m => { m.dsh = { client: { platform: 'web' } }; });
  assert.doesNotThrow(() => validatePackage(files, true));
});

test('ordinary packages require built exports, README and declared license files', () => {
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    const files = ordinary(); files.delete(path);
    assert.throws(() => validatePackage(files, true), /Missing|matches no files/);
  }
  for (const mutate of [
    (m: any) => { m.type = 'commonjs'; },
    (m: any) => { m.files = []; },
    (m: any) => { m.exports = {}; },
    (m: any) => { delete m.exports; },
    (m: any) => { m.exports = { '.': './src/index.ts' }; },
    (m: any) => { m.exports = { './other/*': './missing/*.js' }; },
    (m: any) => { m.license = 'SEE LICENSE IN legal.txt'; },
    (m: any) => { m.scripts = { install: 'tsc' }; },
    (m: any) => { m.dependencies = { external: 'file:../external' }; },
    (m: any) => { m.peerDependencies = { external: 'workspace:*' }; },
    (m: any) => { m.optionalDependencies = { external: '../external' }; },
  ]) {
    const files = ordinary(); change(files, mutate);
    assert.throws(() => validatePackage(files, true), /ESM|publish files|exports|built files|matches no files|Missing|lifecycle|distributable/);
  }
});

test('packs bundles and ordinary companions while skipping private ordinary tooling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-package-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, files] of [['bundle', fixture()], ['adapter', ordinary()], ['ui', ordinary()]] as const) {
    change(files, m => { m.name = '@fixture/' + name; });
    if (name === 'bundle') files.set('cordis.patch.yml', Buffer.from('- insert: [{id: fixture, name: "@fixture/bundle"}]'));
    for (const [path, bytes] of files) {
      const target = join(root, 'packages', name, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  await mkdir(join(root, 'packages/tooling'));
  await writeFile(join(root, 'packages/tooling/package.json'), '{"private":true}');
  await checkPackages(root, true);
  const names: unknown[] = [];
  for (const directory of await readdir(join(root, '.artifacts'))) {
    for (const archive of await readdir(join(root, '.artifacts', directory))) {
      names.push(validatePackage(await tarFiles(join(root, '.artifacts', directory, archive)), true).name);
    }
  }
  assert.deepEqual(names.sort(), ['@fixture/adapter', '@fixture/bundle', '@fixture/ui']);
});

test('validates replacement modules without requiring official target dependencies or exports', () => {
  const files = fixture();
  files.set('cordis.patch.yml', Buffer.from('- id: official\n  name: "@deepseek-ai/dsh-official"\n  disabled: true\n- id: self-old\n  name: "@fixture/dsh-demo/not-exported"\n  disabled: true\n' + files.get('cordis.patch.yml')!.toString()));
  assert.deepEqual(validatePackage(files, true).dependencies, {});
  change(files, m => { delete m.exports['.']; });
  assert.throws(() => validatePackage(files), /Host plugin/);
});

test('rejects conflicting replacement targets and unsupported overrides in package validation', () => {
  for (const patch of [
    '- id: official\n  disabled: true\n- id: official\n  disabled: true\n',
    '- id: fixture.demo\n  disabled: true\n',
    '- id: official\n  disabled: true\n  config: {}\n',
  ]) {
    const files = fixture();
    files.set('cordis.patch.yml', Buffer.from(patch + files.get('cordis.patch.yml')!.toString()));
    assert.throws(() => validatePackage(files), /target ownership|existing-row disables/);
  }
});

test('validates directory and distributable package content', () => {
  assert.equal(validatePackage(fixture()).name, '@fixture/dsh-demo');
  assert.equal(validatePackage(fixture(), true).version, '0.1.0');
});
for (const path of ['dist/index.js', 'locale/zh.json', 'icon.svg', 'cordis.patch.yml', 'README.md']) {
  test(`rejects missing published resource ${path}`, () => {
    const files = fixture(); files.delete(path);
    assert.throws(() => validatePackage(files, true), /Missing|matches no files/);
  });
}
test('rejects unsafe exports and invalid compatibility declarations', () => {
  const files = fixture();
  change(files, m => { m.exports['.'] = './../outside.js'; });
  assert.throws(() => validatePackage(files), /Unsafe/);
  const invalid = fixture(); change(invalid, m => { m.engines.dsh = 'workspace:*'; });
  assert.throws(() => validatePackage(invalid), /SemVer/);
});
test('rejects packed workspace/local dependencies but allows them during development', () => {
  const files = fixture(); change(files, m => { m.dependencies['@fixture/shared'] = 'workspace:*'; });
  validatePackage(files);
  assert.throws(() => validatePackage(files, true), /not distributable/);
});
test('rejects empty engines, private bundles and malformed packed dependency fields', () => {
  for (const range of ['', ' ']) {
    const files = fixture(); change(files, m => { m.engines.dsh = range; });
    assert.throws(() => validatePackage(files), /SemVer/);
  }
  const privateFiles = fixture(); change(privateFiles, m => { m.private = true; });
  assert.throws(() => validatePackage(privateFiles, true), /private bundles/);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const range of ['', '/tmp/local', '../local', 'file:../local', 'workspace:*']) {
      const files = fixture(); change(files, m => { m[field] = { local: range }; });
      assert.throws(() => validatePackage(files, true), /dependency/);
    }
    const files = fixture(); change(files, m => { m[field] = { '../bad': '1.0.0' }; });
    assert.throws(() => validatePackage(files, true), /name/);
  }
});
test('rejects types-only and unexported self-subpath Host entries', () => {
  const types = fixture(); change(types, m => { m.exports['.'] = { types: './README.md' }; });
  assert.throws(() => validatePackage(types), /runtime/);
  const subpath = fixture(); subpath.set('cordis.patch.yml', Buffer.from('- insert:\n    - id: demo\n      name: "@fixture/dsh-demo/missing"\n'));
  assert.throws(() => validatePackage(subpath), /explicit/);
});
test('rejects install scripts, missing Host export and duplicate rows', () => {
  const scripts = fixture(); change(scripts, m => { m.scripts = { postinstall: 'tsc' }; });
  assert.throws(() => validatePackage(scripts), /lifecycle/);
  const entry = fixture(); change(entry, m => { delete m.exports['.']; });
  assert.throws(() => validatePackage(entry), /Host plugin/);
  const duplicate = fixture(); duplicate.set('cordis.patch.yml', Buffer.from(`${duplicate.get('cordis.patch.yml')}${duplicate.get('cordis.patch.yml')}`));
  assert.throws(() => validatePackage(duplicate), /Duplicate row/);
});
