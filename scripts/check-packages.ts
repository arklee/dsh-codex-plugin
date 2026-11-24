import { readFile, readdir, lstat, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { valid, validRange } from 'semver';
import { t as listTar } from 'tar';
import { dependencies, packageName, parseAssemblyPatch, patchPath } from './lib/assembly.ts';
import type { Manifest } from './lib/assembly.ts';

export type PackageFiles = Map<string, Buffer>;
function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function safePath(path: string): string {
  const clean = path.replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || clean.split('/').some(part => !part || part === '.' || part === '..')) fail(`Unsafe package resource path: ${path}`);
  return clean;
}
function readJson(files: PackageFiles, path: string): Record<string, unknown> {
  const data = files.get(safePath(path));
  if (!data) fail(`Missing package resource: ${path}`);
  return record(JSON.parse(data.toString('utf8')), path);
}
function requireFile(files: PackageFiles, path: string): string {
  const clean = safePath(path);
  if (!files.has(clean)) fail(`Missing package resource: ${path}`);
  return clean;
}
function checkExport(files: PackageFiles, value: unknown): void {
  if (value === null) return;
  if (typeof value === 'string') {
    if (!value.startsWith('./')) fail(`Export target must start with ./: ${value}`);
    const clean = safePath(value);
    if (clean.includes('*')) {
      const expression = new RegExp(`^${clean.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (![...files.keys()].some(path => expression.test(path))) fail(`Export matches no files: ${value}`);
    } else requireFile(files, clean);
    return;
  }
  if (Array.isArray(value)) { value.forEach(item => checkExport(files, item)); return; }
  Object.values(record(value, 'exports')).forEach(item => checkExport(files, item));
}
function runtimeExport(files: PackageFiles, value: unknown, label: string): void {
  if (typeof value === 'string') {
    if (!/\.(?:mjs|cjs|js)$/.test(value)) fail(`${label}: runtime export must point to built JavaScript`);
    requireFile(files, value);
    return;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [condition, target] of Object.entries(value)) {
      if (['node', 'import', 'default'].includes(condition)) return runtimeExport(files, target, label);
    }
  }
  fail(`${label}: mounted plugins require an explicit runtime import/default export (not only types)`);
}
/** Validate real directory contents or exactly the files present in a packed tarball. */
export function validatePackage(files: PackageFiles, packed = false): Manifest {
  const manifest = readJson(files, 'package.json');
  if (typeof manifest.name !== 'string' || packageName(manifest.name) !== manifest.name) fail('Invalid package name');
  if (typeof manifest.version !== 'string' || !valid(manifest.version)) fail(`${manifest.name}: invalid version`);
  const engines = record(manifest.engines, 'engines');
  if (typeof engines.dsh !== 'string' || !engines.dsh.trim() || !validRange(engines.dsh)) fail(`${manifest.name}: engines.dsh must be a valid SemVer range`);
  if (manifest.type !== 'module') fail(`${manifest.name}: use ESM (type: module)`);
  if (!Array.isArray(manifest.files) || !manifest.files.length) fail(`${manifest.name}: declare publish files`);
  const exports = record(manifest.exports, 'exports');
  checkExport(files, exports);
  const patch = requireFile(files, patchPath(manifest));
  const rows = parseAssemblyPatch(files.get(patch)!.toString('utf8'), manifest, manifest.name);
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id as string)) fail(`Duplicate row id: ${row.id}`);
    ids.add(row.id as string);
    const specifier = row.name as string;
    if (packageName(specifier) === manifest.name) {
      const subpath = specifier === manifest.name ? '.' : `.${specifier.slice((manifest.name as string).length)}`;
      if (!exports[subpath]) fail(`${manifest.name}: mounted Host plugin needs an explicit ${subpath} export`);
      runtimeExport(files, exports[subpath], `${manifest.name}${subpath}`);
    }
  }
  if (exports['./locale/*.json'] !== './locale/*.json') fail('Export ./locale/*.json to ./locale/*.json');
  for (const locale of ['en', 'zh']) {
    const meta = record(readJson(files, `locale/${locale}.json`).meta, `locale/${locale}.json meta`);
    for (const key of ['title', 'description']) if (typeof meta[key] !== 'string' || !meta[key].trim()) fail(`locale/${locale}.json: meta.${key} is required`);
    if (meta.detail !== undefined) {
      if (typeof meta.detail !== 'string') fail('meta.detail must be a path string');
      requireFile(files, meta.detail);
    }
  }
  const icon = manifest.icon ?? exports['./icon'];
  if (typeof icon !== 'string') fail('Provide an icon path or ./icon export');
  const iconPath = requireFile(files, icon);
  const iconBytes = files.get(iconPath)!;
  if (!/\.(svg|png|jpe?g|webp)$/i.test(iconPath) || iconBytes.length === 0 || iconBytes.length > 256 * 1024) fail('Icon must be a nonempty SVG/PNG/JPEG/WebP of at most 256 KiB');
  if (iconPath.endsWith('.svg') && !/<svg\b/.test(iconBytes.toString('utf8'))) fail('SVG icon has no SVG root');
  requireFile(files, 'README.md');
  dependencies(manifest);
  if (packed && manifest.private === true) fail(`${manifest.name}: private bundles cannot be published`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] === undefined) continue;
    for (const [name, range] of Object.entries(record(manifest[field], field))) {
      if (packageName(name) !== name) fail(`Invalid dependency package name: ${name}`);
      if (typeof range !== 'string' || !range.trim()) fail(`Invalid dependency range: ${name}=${range}`);
      // Initial publishing policy intentionally supports registry SemVer ranges only.
      if (packed && !validRange(range)) fail(`Packed dependency is not distributable: ${name}=${range}; use a registry SemVer range`);
    }
  }
  const scripts = manifest.scripts === undefined ? {} : record(manifest.scripts, 'scripts');
  for (const name of ['preinstall', 'install', 'postinstall']) if (scripts[name]) fail(`${manifest.name}: installation must not require lifecycle scripts`);
  return manifest;
}

export async function directoryFiles(directory: string): Promise<PackageFiles> {
  const files: PackageFiles = new Map();
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      const full = join(path, entry.name);
      if ((await lstat(full)).isSymbolicLink()) fail(`Package resources cannot be symlinks: ${full}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.set(relative(directory, full).replaceAll('\\', '/'), await readFile(full));
    }
  }
  await walk(directory);
  return files;
}
export async function tarFiles(archive: string): Promise<PackageFiles> {
  const files: PackageFiles = new Map();
  await listTar({ file: archive, onReadEntry(entry) {
    if (entry.type === 'Directory') { entry.resume(); return; }
    if (entry.type !== 'File' || !entry.path.startsWith('package/')) fail(`Unsupported archive entry: ${entry.path} (${entry.type})`);
    const path = safePath(entry.path.slice('package/'.length));
    if (files.has(path)) fail(`Duplicate archive path: ${path}`);
    const chunks: Buffer[] = [];
    entry.on('data', chunk => chunks.push(Buffer.from(chunk)));
    entry.on('end', () => files.set(path, Buffer.concat(chunks)));
  } });
  return files;
}
export function runPnpm(args: string[], cwd: string): string {
  const executable = process.env.npm_execpath;
  // pnpm scripts expose the exact pinned JS entry, avoiding shell argument quoting.
  return execFileSync(executable ? process.execPath : 'pnpm', executable ? [executable, ...args] : args, {
    cwd, encoding: 'utf8', env: { ...process.env, npm_config_ignore_scripts: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export async function packPackage(directory: string, output: string): Promise<string> {
  await mkdir(output, { recursive: true });
  const before = new Set(await readdir(output));
  runPnpm(['pack', '--pack-destination', output], directory);
  const archives = (await readdir(output)).filter(name => name.endsWith('.tgz') && !before.has(name));
  if (archives.length !== 1) fail(`Expected one new tarball for ${directory}, got ${archives.length}`);
  return join(output, archives[0]!);
}
export async function checkPackages(root: string, pack = false): Promise<void> {
  const packages = join(root, 'packages');
  for (const entry of (await readdir(packages, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(packages, entry.name);
    const files = await directoryFiles(directory);
    const manifest = readJson(files, 'package.json');
    if (!manifest.dsh || !record(manifest.dsh, 'dsh').bundle) continue; // Ordinary shared libraries are not DSH bundles.
    validatePackage(files);
    if (pack) {
      await mkdir(join(root, '.artifacts'), { recursive: true });
      const output = await mkdtemp(join(root, '.artifacts', 'pack-'));
      const archive = await packPackage(directory, output);
      validatePackage(await tarFiles(archive), true);
      console.log(`Packed and checked ${manifest.name}: ${relative(root, archive)}`);
    } else console.log(`Checked ${manifest.name}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => arg !== '--pack')) fail('Usage: node scripts/check-packages.ts [--pack]');
    await checkPackages(process.cwd(), args.includes('--pack'));
  } catch (error) {
    console.error(`check-packages: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
