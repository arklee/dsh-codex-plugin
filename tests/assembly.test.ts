import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { generateAssembly, parseAssemblyPatch, parseSuiteConfig, patchPath } from '../scripts/lib/assembly.ts';
import type { AssemblyPackage, Manifest } from '../scripts/lib/assembly.ts';
import { runGeneration } from '../scripts/generate-suite.ts';

const suite: Manifest = { name: '@test/suite', version: '0.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } }, dependencies: {} };
function pkg(name = 'a', patch = `- insert:\n    - id: test-${name}\n      name: '@test/${name}'\n`, deps: Record<string, string> = {}): AssemblyPackage {
  return { directory: `packages/${name}`, manifest: { name: `@test/${name}`, dsh: { bundle: { patch: 'cordis.patch.yml' } }, dependencies: deps }, patch };
}

test('empty suite is reproducible and contains no placeholder plugins', () => {
  const output = generateAssembly([], suite);
  assert.match(output.patch, /Sources \(ordered\): \(none\)/);
  assert.deepEqual(parse(output.patch), []);
  assert.deepEqual(output.manifest.dependencies, {});
  assert.deepEqual(output, generateAssembly([], suite));
});

test('preserves all supported metadata and config, order and namespaced ids', () => {
  const a = pkg('a', `- insert:\n    - id: test-host\n      name: '@test/a'\n      config: { nested: [null, true, 2.5, { label: hello }] }\n      disabled: null\n      inject: [logger]\n      intercept: { logger: { level: 2 } }\n      isolate: { logger: realm, cache: true }\n- insert:\n    - id: test-client\n      name: '@test/a/client'\n      disabled: true\n      inject: { logger: { required: false } }\n`);
  const b = pkg('b');
  const output = generateAssembly([a, b], suite);
  const expected = [...parseAssemblyPatch(a.patch, a.manifest), ...parseAssemblyPatch(b.patch, b.manifest)];
  assert.deepEqual(parse(output.patch), [{ insert: expected }]);
  assert.deepEqual(output.manifest.dependencies, { '@test/a': 'workspace:*', '@test/b': 'workspace:*' });
  assert.equal(output.patch, generateAssembly([a, b], suite).patch);
});

test('preserves handwritten external dependencies and replaces generated workspace dependencies', () => {
  const output = generateAssembly([pkg()], { ...suite, dependencies: { '@test/old': 'workspace:*', external: '^1.0.0' } });
  assert.deepEqual(output.manifest.dependencies, { '@test/a': 'workspace:*', external: '^1.0.0' });
});

test('promotes referenced direct dependency so suite can resolve it without hoisting', () => {
  const a = pkg('a', '- insert: [{ id: test-external, name: external/plugin }]\n', { external: '^2.0.0' });
  assert.deepEqual(generateAssembly([a], suite).manifest.dependencies, { '@test/a': 'workspace:*', external: '^2.0.0' });
  assert.throws(() => generateAssembly([a], { ...suite, dependencies: { external: '^1.0.0' } }), /Conflicting suite dependency/);
});

test('preserves disable and replacement ordering without requiring official dependencies', () => {
  const a = pkg('a', '- id: official-a\n  name: "@deepseek-ai/dsh-official"\n  disabled: true\n- insert: [{id: replacement-a, name: "@test/a"}]\n- id: official-client\n  disabled: true\n- insert: [{id: replacement-client, name: "@test/a/client"}]\n');
  const b = pkg('b', '- id: official-b\n  disabled: true\n- insert: [{id: replacement-b, name: "@test/b"}]\n');
  const output = generateAssembly([a, b], suite);
  assert.deepEqual(parse(output.patch), [...parse(a.patch), ...parse(b.patch)]);
  assert.deepEqual(parseAssemblyPatch(a.patch, a.manifest).map(row => row.id), ['replacement-a', 'replacement-client']);
  assert.deepEqual(output.manifest.dependencies, { '@test/a': 'workspace:*', '@test/b': 'workspace:*' });
  assert.deepEqual(generateAssembly([a, b], suite), output);
  assert.deepEqual(parseAssemblyPatch(output.patch, output.manifest).map(row => row.id), ['replacement-a', 'replacement-client', 'replacement-b']);
});

test('rejects duplicate disables and insert/disable ownership conflicts in either order', () => {
  const disable = '- id: shared\n  disabled: true\n';
  const asserted = '- id: shared\n  name: "@deepseek-ai/other"\n  disabled: true\n';
  const insert = '- insert: [{id: shared, name: "@test/a"}]\n';
  for (const patch of [disable + disable, disable + asserted, disable + insert, insert + disable]) {
    assert.throws(() => parseAssemblyPatch(patch, pkg().manifest), /target ownership/);
  }
  for (const patches of [[disable, disable], [disable, asserted], [disable, insert], [insert, disable]]) {
    const a = pkg('a', patches[0]);
    const b = pkg('b', patches[1]!.replace('@test/a', '@test/b'));
    assert.throws(() => generateAssembly([a, b], suite), /target ownership/);
  }
});

const rejected: [string, string, RegExp][] = [
  ['reenable', '- id: official\n  disabled: false', /existing-row disables/],
  ['null disable', '- id: official\n  disabled: null', /existing-row disables/],
  ['string disable', '- id: official\n  disabled: "true"', /existing-row disables/],
  ['disable config', '- id: official\n  disabled: true\n  config: {}', /existing-row disables/],
  ['disable unknown field', '- id: official\n  disabled: true\n  typo: true', /existing-row disables/],
  ['disable group', '- id: official\n  disabled: true\n  group: true', /existing-row disables/],
  ['disable inject', '- id: official\n  disabled: true\n  inject: []', /existing-row disables/],
  ['disable missing id', '- disabled: true', /target id/],
  ['disable empty id', '- id: ""\n  disabled: true', /target id/],
  ['disable empty assertion', '- id: official\n  name: ""\n  disabled: true', /name assertion/],
  ['disable relative assertion', '- id: official\n  name: ./index.js\n  disabled: true', /Unsupported npm plugin name/],
  ['disable mixed insert', '- id: official\n  disabled: true\n  insert: []', /only flat insert/],
  ['override', '- id: existing\n  config: {}', /only flat insert/],
  ['group target', '- id: group\n  insert: []', /only flat insert/],
  ['group row', '- insert: [{id: a, name: cordis:group, group: true}]', /unsupported row field/],
  ['unknown field', '- insert: [{id: a, name: "@test/a", typo: true}]', /unsupported row field/],
  ['relative plugin', '- insert: [{id: a, name: ./index.js}]', /Unsupported npm plugin name/],
  ['absolute plugin', '- insert: [{id: a, name: /index.js}]', /Unsupported npm plugin name/],
  ['undeclared plugin', '- insert: [{id: a, name: external}]', /direct dependencies/],
  ['missing id', '- insert: [{name: "@test/a"}]', /row id/],
  ['disabled expression string', '- insert: [{id: a, name: "@test/a", disabled: "true"}]', /disabled must/],
  ['invalid isolate', '- insert: [{id: a, name: "@test/a", isolate: {logger: false}}]', /isolate values/],
  ['javascript tag', '- insert: [{id: a, name: "@test/a", config: !!js "ctx.foo"}]', /YAML tags/],
  ['standard tag', '- insert: [{id: a, name: "@test/a", config: !!str hi}]', /YAML tags/],
  ['custom tag', '- insert: [{id: a, name: "@test/a", config: !custom hi}]', /YAML tags/],
  ['anchor', '- insert: [{id: a, name: "@test/a", config: &cfg {x: 1}}]', /YAML anchors/],
  ['alias', '- insert: [{id: a, name: "@test/a", config: *cfg}]', /YAML aliases/],
  ['merge key', '- insert: [{id: a, name: "@test/a", config: {<<: {x: 1}}}]', /YAML merges/],
  ['complex key', '- insert: [{id: a, name: "@test/a", config: {? [a, b]: x}}]', /mapping keys/],
  ['nonstring key', '- insert: [{id: a, name: "@test/a", config: {1: x}}]', /mapping keys/],
  ['duplicate yaml key', '- insert: [{id: a, id: b, name: "@test/a"}]', /unique/],
  ['nonfinite config', '- insert: [{id: a, name: "@test/a", config: {x: .inf}}]', /ordinary JSON/],
  ['unsafe integer', '- insert: [{id: a, name: "@test/a", config: {x: 9007199254740993}}]', /ordinary JSON/],
  ['multiple documents', '[]\n---\n[]', /multiple documents/i],
  ['bare entries', '- id: a\n  name: "@test/a"', /only flat insert/],
];
for (const [name, input, pattern] of rejected) test(`rejects ${name} without dropping information`, () => {
  assert.throws(() => parseAssemblyPatch(input, pkg().manifest), pattern);
});

test('supports manifest patch paths with a leading dot slash', () => {
  assert.doesNotThrow(() => generateAssembly([], { ...suite, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
});

test('rejects duplicate row ids within one standalone patch', () => {
  assert.throws(() => parseAssemblyPatch('- insert: [{id: a, name: "@test/a"}, {id: a, name: "@test/a/client"}]', pkg().manifest), /Duplicate row id/);
});

test('validates duplicate row ids across packages', () => {
  assert.throws(() => generateAssembly([pkg(), pkg('b', '- insert: [{id: test-a, name: "@test/b"}]')], suite), /Duplicate row id/);
});

test('rejects duplicate and escaping configuration paths', () => {
  for (const path of ['../outside', '/tmp/a', 'packages/../a', 'packages/a/b', 'packages/suite', 'packages/a\\b']) assert.throws(() => parseSuiteConfig({ packages: [path] }), /Invalid suite package path/);
  assert.throws(() => parseSuiteConfig({ packages: ['packages/a', 'packages/a'] }), /Duplicate package path/);
  assert.throws(() => parseSuiteConfig({ packages: [], other: true }), /expected only/);
  assert.throws(() => patchPath({ dsh: { bundle: { patch: '../outside.yml' } } }), /Unsafe/);
  assert.throws(() => patchPath({ dsh: { bundle: { patch: ['one.yml'] } } }), /nonempty string/);
});

test('validates workspace graph including shared libraries, missing packages and cycles', () => {
  const a = pkg('a', undefined, { '@test/shared': 'workspace:*' });
  assert.throws(() => generateAssembly([a], suite), /missing workspace dependency/);
  const shared = { name: '@test/shared', dependencies: {} };
  assert.doesNotThrow(() => generateAssembly([a], suite, [a.manifest, shared]));
  assert.throws(() => generateAssembly([a], suite, [a.manifest, { ...shared, dependencies: { '@test/a': 'workspace:*' } }]), /Circular workspace/);
  assert.throws(() => generateAssembly([pkg()], suite, [pkg().manifest, pkg().manifest]), /Duplicate workspace package name/);
});

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-assembly-'));
  t.after(async () => {
    assert.equal(resolve(root), root);
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-assembly-')));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'packages/suite'), { recursive: true });
  await writeFile(join(root, 'suite.config.json'), JSON.stringify({ packages: [] }));
  await writeFile(join(root, 'packages/suite/package.json'), `${JSON.stringify(suite, null, 2)}\n`);
  return root;
}

test('check detects missing or stale output without writing; generate then check is idempotent', async t => {
  const root = await fixture(t);
  await assert.rejects(runGeneration(root, true), /Generated suite drift/);
  await assert.rejects(readFile(join(root, 'packages/suite/cordis.patch.yml')), /ENOENT/);
  assert.deepEqual(await runGeneration(root), ['packages/suite/cordis.patch.yml']);
  assert.deepEqual(await runGeneration(root, true), []);
  const stale = '# handwritten drift\n[]\n';
  await writeFile(join(root, 'packages/suite/cordis.patch.yml'), stale);
  await assert.rejects(runGeneration(root, true), /Generated suite drift/);
  assert.equal(await readFile(join(root, 'packages/suite/cordis.patch.yml'), 'utf8'), stale);
});

test('loads explicit packages and preserves source ordering', async t => {
  const root = await fixture(t);
  for (const item of [pkg('a'), pkg('b')]) {
    await mkdir(join(root, item.directory));
    await writeFile(join(root, item.directory, 'package.json'), JSON.stringify(item.manifest));
    await writeFile(join(root, item.directory, 'cordis.patch.yml'), item.patch);
  }
  await writeFile(join(root, 'suite.config.json'), JSON.stringify({ packages: ['packages/b', 'packages/a'] }));
  await runGeneration(root);
  const generated = parse(await readFile(join(root, 'packages/suite/cordis.patch.yml'), 'utf8'));
  assert.deepEqual(generated[0].insert.map((row: { id: string }) => row.id), ['test-b', 'test-a']);
  assert.deepEqual(await runGeneration(root, true), []);
});

test('rejects symlinked package directories escaping packages root', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'packages/escape'), 'dir');
  await assert.rejects(runGeneration(root), /Path escapes/);
});

test('rejects output symlinks without touching target', async t => {
  const root = await fixture(t);
  const target = join(root, 'precious.yml');
  await writeFile(target, 'keep me');
  await symlink(target, join(root, 'packages/suite/cordis.patch.yml'));
  await assert.rejects(runGeneration(root), /must not be a symlink/);
  assert.equal(await readFile(target, 'utf8'), 'keep me');
});
