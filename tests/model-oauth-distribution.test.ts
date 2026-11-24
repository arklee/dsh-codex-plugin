import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { packPackage, runPnpm, tarFiles, validatePackage } from '../scripts/check-packages.ts';

test('packed OAuth bundle resolves from both clean installation entries', { timeout: 120_000 }, async () => {
  const root = resolve(import.meta.dirname, '..');
  const temp = await mkdtemp(join(tmpdir(), 'model-oauth-pack-'));
  try {
    const archives: Record<string, string> = {};
    let featureVersion: unknown;
    for (const slug of ['model-oauth', 'suite']) {
      const archive = await packPackage(join(root, 'packages', slug), join(temp, 'packs'));
      const files = await tarFiles(archive);
      const manifest = validatePackage(files, true);
      if (slug === 'model-oauth') featureVersion = manifest.version;
      else assert.equal((manifest.dependencies as Record<string, string>)['@arkli/dsh-model-oauth'], featureVersion);
      archives[String(manifest.name)] = 'file:' + archive;
    }
    for (const entry of Object.keys(archives)) {
      const consumer = join(temp, entry.split('/')[1]!);
      await mkdir(consumer);
      await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [entry]: archives[entry] } }));
      await writeFile(join(consumer, 'pnpm-workspace.yaml'), stringify({ packages: [], ignoreScripts: true,
        overrides: archives, storeDir: join(root, '.pnpm-store'), cacheDir: join(root, '.pnpm-cache') }));
      runPnpm(['install', '--prefer-offline', '--ignore-scripts'], consumer);
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        import { readFileSync } from 'node:fs';
        import { pathToFileURL } from 'node:url';
        import { runInNewContext } from 'node:vm';
        const resolveFromEntry = createRequire(import.meta.resolve(process.argv[1] + '/icon')).resolve;
        const host = await import(pathToFileURL(resolveFromEntry('@arkli/dsh-model-oauth')));
        if (!host.default && !host.apply) throw new Error('No host entry');
        let registration;
        runInNewContext(readFileSync(resolveFromEntry('@arkli/dsh-model-oauth/client'), 'utf8'),
          { window: { __ModuleLoader__: { load: value => registration = value } } });
        if (registration?.id !== '@arkli/dsh-model-oauth' || typeof registration.factory !== 'function')
          throw new Error('Missing client registration');
      `, entry], { cwd: consumer });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
