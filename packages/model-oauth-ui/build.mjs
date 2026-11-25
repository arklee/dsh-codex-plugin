/** Build the portable DSH Host entry and deferred-resource Client factory. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const license = '/*! Derived from DeepSeek Harness. Copyright (c) 2026 DeepSeek. MIT; see LICENSE. */'
// These identities are supplied by the DSH 0.2.3-alpha.2 browser platform.
const external = [
  'react', 'react/jsx-runtime', '@deepseek-ai/cordis', 'zod',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const stylesheets = new Map()
const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: 'dist/client.js',
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2024',
  jsx: 'automatic', external, write: false,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'dsh-deferred-css-modules',
    setup(builder) {
      builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
        const name = relative(root, path).replaceAll('\\', '/')
        const result = transform({
          filename: name, code: await readFile(path),
          cssModules: { pattern: '[hash]_[local]' }, minify: true,
        })
        stylesheets.set(name, result.code.toString())
        const classes = Object.fromEntries(Object.entries(result.exports ?? {})
          .map(([key, value]) => [key, value.name]))
        return { contents: `export default ${JSON.stringify(classes)};`, loader: 'js' }
      })
    },
  }],
})
const resources = [...stylesheets].sort(([a], [b]) => a.localeCompare(b))
  .map(([name, css]) => `${JSON.stringify(name)}: { text: () => ${JSON.stringify(css)} }`).join(",")
const code = [
  license,
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  client.outputFiles[0].text,
  `return module.exports; }, meta: () => ({ stylesheets: {${resources}} }) });`,
  '',
].join('\n')
await mkdir(resolve(root, 'dist'), { recursive: true })
await writeFile(resolve(root, 'dist/client.js'), code)
await build({
  absWorkingDir: root, entryPoints: ['src/index.ts'], outfile: 'dist/index.js',
  bundle: true, format: 'esm', platform: 'node', target: 'es2024',
  packages: 'external', banner: { js: license },
})
