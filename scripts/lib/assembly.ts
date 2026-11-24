import { isAlias, isMap, isScalar, parseDocument, stringify, visit } from 'yaml';

export type Manifest = Record<string, unknown>;
export interface AssemblyPackage { directory: string; manifest: Manifest; patch: string }
export interface AssemblyResult { patch: string; manifest: Manifest }

function fail(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: expected an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}: expected a nonempty string`);
  return value;
}
export function packageName(specifier: string): string {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/.test(specifier)
    || specifier.split('/').some(part => part === '.' || part === '..')) fail(`Unsupported npm plugin name: ${specifier}`);
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!;
}
export function dependencies(manifest: Manifest): Record<string, string> {
  const raw = manifest.dependencies === undefined ? {} : object(manifest.dependencies, 'dependencies');
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => {
    if (packageName(name) !== name) fail(`Invalid dependency package name: ${name}`);
    return [name, text(value, `dependency ${name}`)];
  }));
}
export function parseSuiteConfig(value: unknown): string[] {
  const config = object(value, 'suite.config.json');
  if (Object.keys(config).some(key => key !== 'packages') || !Array.isArray(config.packages)) fail('suite.config.json: expected only a packages array');
  const paths = config.packages.map(value => {
    const path = text(value, 'suite package path');
    if (!/^packages\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path) || path === 'packages/suite') fail(`Invalid suite package path: ${path}; expected packages/<directory>, excluding suite`);
    return path;
  });
  if (new Set(paths).size !== paths.length) fail('Duplicate package path in suite.config.json');
  return paths;
}
export function patchPath(manifest: Manifest): string {
  const dsh = object(manifest.dsh, 'dsh');
  const bundle = object(dsh.bundle, 'dsh.bundle');
  const path = text(bundle.patch, 'dsh.bundle.patch');
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '') || !/\.(?:yaml|yml)$/.test(path)) fail(`Unsafe or unsupported dsh.bundle.patch: ${path}`);
  return path;
}
function json(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return;
  if (Array.isArray(value)) { value.forEach(item => json(item, label)); return; }
  if (value && typeof value === 'object') { Object.values(value).forEach(item => json(item, label)); return; }
  fail(`${label}: only ordinary JSON values and safe numbers are supported`);
}
/** Parse the deliberately restricted, lossless subset of the Loader patch dialect. */
export function parseAssemblyPatch(source: string, manifest: Manifest, label = 'patch'): Record<string, unknown>[] {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) fail(`${label}: ${doc.errors.map(error => error.message).join('; ')}`);
  visit(doc, (_key, node) => {
    if (isAlias(node)) fail(`${label}: YAML aliases are unsupported`);
    if (node && typeof node === 'object') {
      if ('tag' in node && node.tag) fail(`${label}: YAML tags are unsupported (${String(node.tag)})`);
      if ('anchor' in node && node.anchor) fail(`${label}: YAML anchors are unsupported`);
    }
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<') fail(`${label}: mapping keys must be strings; YAML merges are unsupported`);
    }
  });
  if (doc.warnings.length) fail(`${label}: ${doc.warnings.map(warning => warning.message).join('; ')}`);
  const patches: unknown = doc.toJS();
  json(patches, label);
  if (!Array.isArray(patches)) fail(`${label}: expected a YAML list of insert patches`);
  const owner = text(manifest.name, `${label} package name`);
  if (packageName(owner) !== owner) fail(`${label}: invalid package name ${owner}`);
  const allowedNames = new Set([owner, ...Object.keys(dependencies(manifest))]);
  const rows: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const patch of patches) {
    const entry = object(patch, label);
    if (Object.keys(entry).length !== 1 || !Array.isArray(entry.insert)) fail(`${label}: only flat insert patches are supported (no overrides or groups)`);
    for (const raw of entry.insert) {
      const row = object(raw, label);
      const allowed = ['id', 'name', 'config', 'disabled', 'inject', 'intercept', 'isolate'];
      for (const key of Object.keys(row)) if (!allowed.includes(key)) fail(`${label}: unsupported row field ${key}`);
      const id = text(row.id, `${label} row id`);
      if (ids.has(id)) fail(`${label}: Duplicate row id: ${id}`);
      ids.add(id);
      const name = text(row.name, `${label} row name`);
      if (!allowedNames.has(packageName(name))) fail(`${label}: ${name} is not supplied by this package or its direct dependencies`);
      if ('disabled' in row && row.disabled !== null && typeof row.disabled !== 'boolean') fail(`${label}: disabled must be boolean or null`);
      if ('inject' in row && row.inject !== null) {
        if (Array.isArray(row.inject)) row.inject.forEach(item => text(item, `${label} inject`));
        else object(row.inject, `${label} inject`);
      }
      if ('intercept' in row && row.intercept !== null) object(row.intercept, `${label} intercept`);
      if ('isolate' in row && row.isolate !== null) {
        for (const realm of Object.values(object(row.isolate, `${label} isolate`))) if (realm !== true && (typeof realm !== 'string' || !realm)) fail(`${label}: isolate values must be true or nonempty realm strings`);
      }
      rows.push(row);
    }
  }
  return rows;
}
/** Pure generation; workspace manifests include shared libraries for graph validation. */
export function generateAssembly(packages: AssemblyPackage[], suite: Manifest, workspace: Manifest[] = packages.map(pkg => pkg.manifest)): AssemblyResult {
  parseSuiteConfig({ packages: packages.map(pkg => pkg.directory) });
  if (patchPath(suite).replace(/^\.\//, '') !== 'cordis.patch.yml') fail('suite dsh.bundle.patch must be cordis.patch.yml or ./cordis.patch.yml');
  const known = new Map<string, Manifest>();
  for (const manifest of workspace) {
    const name = text(manifest.name, 'workspace package name');
    if (packageName(name) !== name) fail(`Invalid workspace package name: ${name}`);
    if (known.has(name)) fail(`Duplicate workspace package name: ${name}`);
    if (name === suite.name) fail(`Workspace package collides with suite package name: ${name}`);
    known.set(name, manifest);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function walk(name: string): void {
    if (visiting.has(name)) fail(`Circular workspace dependency involving ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const [dependency, range] of Object.entries(dependencies(known.get(name)!))) {
      if (range.startsWith('workspace:') && !known.has(dependency)) fail(`${name}: missing workspace dependency ${dependency}`);
      if (known.has(dependency)) walk(dependency);
    }
    visiting.delete(name); visited.add(name);
  }
  for (const name of known.keys()) walk(name);
  const next = Object.fromEntries(Object.entries(dependencies(suite)).filter(([, range]) => !range.startsWith('workspace:')));
  const rows: Record<string, unknown>[] = [], ids = new Set<string>(), names = new Set<string>();
  for (const pkg of packages) {
    patchPath(pkg.manifest);
    const name = text(pkg.manifest.name, `${pkg.directory} name`);
    if (names.has(name)) fail(`Duplicate selected package name: ${name}`);
    names.add(name);
    if (!known.has(name)) fail(`Selected package is absent from workspace: ${name}`);
    next[name] = 'workspace:*';
    const ownDependencies = dependencies(pkg.manifest);
    for (const row of parseAssemblyPatch(pkg.patch, pkg.manifest, pkg.directory)) {
      const id = row.id as string;
      if (ids.has(id)) fail(`Duplicate row id: ${id}`);
      ids.add(id); rows.push(row);
      const provider = packageName(row.name as string);
      if (provider !== name) {
        const range = known.has(provider) ? 'workspace:*' : ownDependencies[provider]!;
        if (next[provider] && next[provider] !== range) fail(`Conflicting suite dependency ${provider}: ${next[provider]} versus ${range}`);
        next[provider] = range;
      }
    }
  }
  const sources = packages.map(pkg => pkg.directory).join(', ') || '(none)';
  const patch = `# Generated by scripts/generate-suite.ts; do not edit.\n# Sources (ordered): ${sources}\n${stringify(rows.length ? [{ insert: rows }] : [], { lineWidth: 0 })}`;
  return { patch, manifest: { ...suite, dependencies: Object.fromEntries(Object.entries(next).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) } };
}
