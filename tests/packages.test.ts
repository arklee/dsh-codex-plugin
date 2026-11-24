import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePackage } from '../scripts/check-packages.ts';
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
