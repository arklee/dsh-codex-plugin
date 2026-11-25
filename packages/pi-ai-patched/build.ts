import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Ship the patched runtime, rather than requiring consumers to configure pnpm patches.
const root = import.meta.dirname;
const upstream = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))));
const manifest = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8'));
if (manifest.version !== '1.6.0') throw new Error('Expected pi-ai 1.6.0');
await rm(join(root, 'dist'), { recursive: true, force: true });
await cp(join(upstream, 'dist'), join(root, 'dist'), { recursive: true });
execFileSync('patch', ['--batch', '--fuzz=0', '-p1', '-i', join(root, 'gemini-signature.patch')], { cwd: root, stdio: 'inherit' });
// Source maps describe upstream code, not the patched runtime.
const patched = join(root, 'dist/api/openai-completions.js');
await writeFile(patched, (await readFile(patched, 'utf8')).replace(/^\/\/# sourceMappingURL=.*\n?/gm, ''));
await rm(`${patched}.map`, { force: true });
