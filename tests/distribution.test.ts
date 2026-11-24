import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, cp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { createPlugin } from '../scripts/create-plugin.ts';
import { runGeneration } from '../scripts/generate-suite.ts';
import { packPackage, tarFiles, validatePackage, runPnpm } from '../scripts/check-packages.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('scaffold -> build -> standalone/suite tarballs -> offline clean consumers', { timeout: 120_000 }, async () => {
  const temporaryRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, 'dsh-distribution-'));
  try {
    const workspace = join(temporary, 'workspace');
    await mkdir(workspace);
    await cp(join(repository, 'tsconfig.base.json'), join(workspace, 'tsconfig.base.json'));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture-workspace', private: true, type: 'module' }));
    const settings = { packages: ['packages/*'], ignoreScripts: true, storeDir: join(temporary, 'store'), cacheDir: join(temporary, 'cache') };
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), stringify(settings));
    const alpha = await createPlugin({ root: workspace, slug: 'alpha', scope: 'fixture' });
    const beta = await createPlugin({ root: workspace, slug: 'beta', scope: 'fixture' });
    await cp(join(repository, 'packages/suite'), join(workspace, 'packages/suite'), { recursive: true });
    const suiteManifestPath = join(workspace, 'packages/suite/package.json');
    const suite = JSON.parse(await readFile(suiteManifestPath, 'utf8'));
    suite.name = '@fixture/dsh-suite';
    suite.dependencies = {};
    await writeFile(suiteManifestPath, `${JSON.stringify(suite, null, 2)}\n`);
    await writeFile(join(workspace, 'suite.config.json'), '{"packages":["packages/alpha","packages/beta"]}\n');
    await runGeneration(workspace);
    await runGeneration(workspace, true);
    // Uses the repository compiler, but the generated package has no undeclared runtime dependencies.
    for (const plugin of [alpha, beta]) execFileSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', join(plugin.directory, 'tsconfig.json')], { encoding: 'utf8' });
    runPnpm(['install', '--offline', '--ignore-scripts'], workspace);
    const archives: Record<string, string> = {};
    for (const slug of ['alpha', 'beta', 'suite']) {
      const archive = await packPackage(join(workspace, 'packages', slug), join(temporary, 'packs', slug));
      const files = await tarFiles(archive);
      const manifest = validatePackage(files, true);
      archives[manifest.name as string] = archive;
      if (slug === 'suite') assert.deepEqual(manifest.dependencies, { '@fixture/dsh-alpha': '0.0.0', '@fixture/dsh-beta': '0.0.0' });
    }
    for (const mode of ['standalone', 'suite']) {
      const consumer = join(temporary, mode);
      await mkdir(consumer);
      const name = mode === 'standalone' ? '@fixture/dsh-alpha' : '@fixture/dsh-suite';
      await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: `consumer-${mode}`, private: true, type: 'module', dependencies: { [name]: `file:${archives[name]}` } }));
      // Overrides map registry names to freshly packed archives; no registry or workspace links can satisfy the test.
      await writeFile(join(consumer, 'pnpm-workspace.yaml'), stringify({ ...settings, packages: [], overrides: Object.fromEntries(Object.entries(archives).map(([key, value]) => [key, `file:${value}`])) }));
      runPnpm(['install', '--offline', '--ignore-scripts'], consumer);
      const probe = mode === 'standalone'
        ? `import('@fixture/dsh-alpha').then(m => { if (typeof m.apply !== 'function') throw Error('Missing apply'); m.apply(); });`
        : `const { createRequire } = await import('node:module'); const suiteIcon = import.meta.resolve('@fixture/dsh-suite/icon'); const fromSuite = createRequire(suiteIcon); for (const name of ['@fixture/dsh-alpha','@fixture/dsh-beta']) { const m = await import(fromSuite.resolve(name)); if (typeof m.apply !== 'function') throw Error('Missing apply'); m.apply(); }`;
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: consumer, encoding: 'utf8' });
    }
    // Switching composition removes only the generated ownership, not the independent package patch.
    await writeFile(join(workspace, 'suite.config.json'), '{"packages":["packages/beta"]}\n');
    await runGeneration(workspace);
    const reduced = await readFile(join(workspace, 'packages/suite/cordis.patch.yml'), 'utf8');
    assert.doesNotMatch(reduced, /fixture\.alpha/);
    assert.match(await readFile(join(alpha.directory, 'cordis.patch.yml'), 'utf8'), /fixture\.alpha/);
  } finally {
    // Only remove this test's verified mkdtemp directory, never a computed user/workspace path.
    const target = resolve(temporary);
    assert.equal(dirname(target), temporaryRoot);
    assert.ok(target.startsWith(join(temporaryRoot, 'dsh-distribution-')));
    assert.equal(await realpath(target), target);
    await rm(target, { recursive: true });
  }
});
