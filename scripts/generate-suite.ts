import { readFile, writeFile, readdir, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateAssembly, parseSuiteConfig, patchPath } from './lib/assembly.ts';
import type { AssemblyPackage, Manifest } from './lib/assembly.ts';

async function readJson(path: string): Promise<Manifest> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Manifest; }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}
async function contained(root: string, path: string): Promise<string> {
  const physical = await realpath(path);
  if (!inside(root, physical)) throw new Error(`Path escapes workspace/package: ${path}`);
  return physical;
}
async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Load only local files. Check mode never writes, including on missing output. */
export async function runGeneration(root: string, check = false): Promise<string[]> {
  root = await realpath(root);
  const configPath = await contained(root, resolve(root, 'suite.config.json'));
  const selected = parseSuiteConfig(await readJson(configPath));
  const packagesRoot = await contained(root, resolve(root, 'packages'));
  const suiteDir = await contained(packagesRoot, resolve(packagesRoot, 'suite'));
  const suitePath = await contained(suiteDir, resolve(suiteDir, 'package.json'));
  const suiteSource = await readFile(suitePath, 'utf8');
  const suite = await readJson(suitePath);
  const workspace: Manifest[] = [];
  const loaded = new Map<string, { manifest: Manifest; physical: string }>();
  for (const entry of (await readdir(packagesRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'suite' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const physical = await contained(packagesRoot, resolve(packagesRoot, entry.name));
    const manifestPath = resolve(physical, 'package.json');
    try { await lstat(manifestPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await contained(physical, manifestPath);
    const manifest = await readJson(manifestPath);
    workspace.push(manifest);
    loaded.set(`packages/${entry.name}`, { manifest, physical });
  }
  const packages: AssemblyPackage[] = [];
  for (const directory of selected) {
    const pkg = loaded.get(directory);
    if (!pkg) throw new Error(`Selected package is missing a manifest: ${directory}`);
    const path = await contained(pkg.physical, resolve(pkg.physical, patchPath(pkg.manifest)));
    packages.push({ directory, manifest: pkg.manifest, patch: await readFile(path, 'utf8') });
  }
  const result = generateAssembly(packages, suite, workspace);
  const output = resolve(suiteDir, 'cordis.patch.yml');
  // Reject escaping symlinks even when their target is missing.
  try {
    const stat = await lstat(output);
    if (stat.isSymbolicLink()) throw new Error(`Generated output must not be a symlink: ${output}`);
    await contained(suiteDir, output);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await contained(suiteDir, dirname(output));
  const manifestSource = `${JSON.stringify(result.manifest, null, 2)}\n`;
  const drift: string[] = [];
  if (await optionalText(output) !== result.patch) drift.push('packages/suite/cordis.patch.yml');
  if (suiteSource !== manifestSource) drift.push('packages/suite/package.json');
  if (check && drift.length) throw new Error(`Generated suite drift: ${drift.join(', ')}. Run node scripts/generate-suite.ts`);
  if (!check) {
    if (drift.includes('packages/suite/cordis.patch.yml')) await writeFile(output, result.patch);
    if (drift.includes('packages/suite/package.json')) await writeFile(suitePath, manifestSource);
  }
  return drift;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--check') || args.length > 1) throw new Error('Usage: node scripts/generate-suite.ts [--check]');
    const check = args.includes('--check');
    const changed = await runGeneration(process.cwd(), check);
    console.log(check ? 'Suite generated files are current.' : `Suite generated (${changed.length} files updated).`);
  } catch (error) {
    console.error(`generate-suite: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
