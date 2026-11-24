import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { valid } from 'semver';

export interface CreatePluginOptions {
  root: string;
  slug: string;
  scope: string;
  dshVersion?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = join(repositoryRoot, 'templates', 'host-plugin');
const templateFiles = [
  'package.json', 'tsconfig.json', 'src/index.ts', 'cordis.patch.yml',
  'locale/en.json', 'locale/zh.json', 'icon.svg', 'README.md',
];
const segment = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/;
const numeric = '(?:0|[1-9][0-9]*)';
const preIdentifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const exactVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${preIdentifier}(?:\\.${preIdentifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** Creates only a new package; never edits suite configuration or installs anything. */
export async function createPlugin(options: CreatePluginOptions) {
  const { slug } = options;
  if (!segment.test(slug) || slug.length > 80 || ['suite', 'shared'].includes(slug)) {
    throw new Error('Invalid slug: use lowercase kebab-case (max 80); suite/shared are reserved.');
  }
  if (typeof options.scope !== 'string' || !options.scope) {
    throw new Error('An explicit npm scope is required; confirm publication permission first.');
  }
  const scope = options.scope.replace(/^@/, '');
  if (!segment.test(scope) || scope.length > 80) {
    throw new Error('Invalid scope: use a lowercase kebab-case npm scope, optionally prefixed with @.');
  }
  const dshVersion = options.dshVersion ?? '0.2.3-alpha.2';
  // The lexical check rejects permissive prefixes/whitespace; semver also enforces
  // safe integer components and length limits used by the runtime's version checks.
  if (dshVersion.trim() !== dshVersion || !exactVersion.test(dshVersion) || valid(dshVersion) === null) {
    throw new Error('DSH version must be an exact SemVer, including any prerelease suffix.');
  }
  const packageName = `@${scope}/dsh-${slug}`;
  // The separator preserves the boundary: scopes/slugs cannot contain a dot.
  const rowId = `${scope}.${slug}`;
  const tokens: Record<string, string> = { PACKAGE_NAME: packageName, ROW_ID: rowId, SLUG: slug, DSH_VERSION: dshVersion };
  // Read every template before creating anything, so missing templates cannot leave a partial scaffold.
  const rendered = await Promise.all(templateFiles.map(async (file) => {
    const text = await readFile(join(templateRoot, `${file}.template`), 'utf8');
    return [file, text.replace(/__([A-Z_]+)__/g, (_, key: string) => {
      if (!(key in tokens)) throw new Error(`Unknown template token: ${key}`);
      return tokens[key]!;
    })] as const;
  }));
  const root = await realpath(resolve(options.root));
  const packages = join(root, 'packages');
  try { await mkdir(packages); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(packages);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(packages) !== packages) {
    throw new Error('Unsafe packages path: expected a real directory inside the repository.');
  }
  const directory = join(packages, slug);
  // Exclusive mkdir rejects existing directories, files, and even dangling symlinks.
  try { await mkdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Refusing to overwrite existing path: ${directory}`);
    throw error;
  }
  // On I/O failure keep the partial directory for inspection; do not risk deleting user data.
  for (const [file, text] of rendered) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), text, { flag: 'wx' });
  }
  return { directory, packageName, rowId };
}

export function parseArguments(args: string[]): Omit<CreatePluginOptions, 'root'> {
  const slug = args[0];
  if (!slug || slug.startsWith('-')) throw new Error('Usage: pnpm create:plugin <slug> --scope <scope> [--dsh-version <version>]');
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!['--scope', '--dsh-version'].includes(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new Error(`Invalid, repeated, or missing CLI option: ${key}`);
    }
    values.set(key, value);
  }
  const scope = values.get('--scope');
  if (!scope) throw new Error('--scope is required; no publication namespace is assumed.');
  const version = values.get('--dsh-version');
  return { slug, scope, ...(version === undefined ? {} : { dshVersion: version }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await createPlugin({ root: repositoryRoot, ...parseArguments(process.argv.slice(2)) });
    console.log(`Created ${result.packageName} in ${result.directory}. The Host row is disabled and implements no business functionality.`);
    console.log('Recheck the target DSH version and APIs before development. Implement and test the plugin before enabling or publishing.');
    console.log('Suite configuration was not changed. To include this package, add it manually to suite.config.json, then run pnpm suite:generate.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
