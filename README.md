# DSH plugins monorepo

A pnpm + TypeScript monorepo for developing and distributing DeepSeek Harness plugins: **install each feature independently, or install a suite that combines them**.

## Current status

The workspace, Host plugin scaffold, aggregate assembly generator, package-content validation, independent versioning, and CI are implemented.

The [model OAuth replacement](packages/model-oauth/README.md) replaces the built-in model adapter and Models settings page with pi-ai 1.6.0 and provider OAuth. It is available independently or through `packages/suite`. Existing model configuration requires an explicit migration to the replacement row; credentials retain their original storage keys. No npm packages have been published.

## Quick start

Requires **Node.js ≥ 24.22.3**, **pnpm 11.28.5**, and the `patch` utility for building the pi-ai derivative. Use your existing pnpm/Corepack installation method; the repository pins the `packageManager` version.

```sh
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

pnpm 11 workspace settings are in `pnpm-workspace.yaml`. Dependency installation scripts are disabled by default, and the store/cache live in ignored directories within this repository; no writes to a DSH profile are required.

### Add a plugin

Replace `your-scope` below with the npm scope you actually use. `codex` is an example name, not a claim that Codex integration has been implemented.

```sh
pnpm create:plugin codex --scope your-scope --dsh-version 0.2.3-alpha.2
pnpm install --ignore-scripts
pnpm --filter @your-scope/dsh-codex build
```

Then:

1. Implement the feature in `packages/codex/src/index.ts`; first check the target DSH version and its actual APIs.
2. Add dependencies, a Config schema, tools/events/services as needed, and release lifecycle-bound resources correctly.
3. Add tests and a `test` script for the package, and update its README, bilingual locales, and icon.
4. Once implementation is complete, change `disabled: true` in the package patch to the desired default state.
5. Run the checks, then explicitly request installation and validation in an isolated DSH profile.

The scaffold does not overwrite existing directories, automatically add the plugin to the suite, or install it into DSH.

### Add it to the suite

Edit `suite.config.json`:

```json
{
  "packages": ["packages/codex"]
}
```

Run:

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

The generator updates the suite patch and workspace dependencies. **npm dependencies alone do not recursively activate child bundles' patches.** Avoid enabling overlapping assemblies from both standalone plugins and the suite at the same time.

See the [plugin development guide](docs/plugin-development.md) for the full process.

## Common commands

| Command | Purpose |
|---|---|
| `pnpm create:plugin <slug> --scope <scope>` | Generate a Host development scaffold that is disabled by default |
| `pnpm suite:generate` | Generate the suite patch and dependencies from an explicit list |
| `pnpm suite:check` | Check for drift in generated content without writing files |
| `pnpm build` | Generate the suite, then build packages in workspace order |
| `pnpm typecheck` | Type-check tooling scripts and packages |
| `pnpm test` | Run tooling unit tests, offline distribution integration tests, and package tests |
| `pnpm check:packages` | Check bundle entry points, patches, metadata, and resources |
| `pnpm check:pack` | Run pnpm pack and validate the actual tarball contents |
| `pnpm check` | Check generated-file consistency, build, type-check, test, and validate resources in package directories |
| `pnpm changeset` | Record independent package version notes for user-visible changes |
| `pnpm version:packages` | Apply Changesets, regenerate the suite, and update the lockfile |

`pnpm check` **does not replace** `pnpm check:pack`; CI runs both. Packed artifacts are retained in ignored `.artifacts/pack-*` directories for inspection.

## Directory layout

```text
packages/model-oauth/  Standalone replacement bundle
packages/model-oauth-adapter/ Replacement model adapter
packages/model-oauth-authorization/ OAuth RPC controller
packages/model-oauth-ui/ Replacement Models settings UI
packages/pi-ai-patched/ Redistributable patched pi-ai runtime
packages/suite/         Aggregate bundle
templates/host-plugin/ Development template, not a feature plugin
scripts/               Scaffolding, assembly, and package-validation tools
tests/                 Tooling and isolated distribution tests
docs/                  Development and release guides
.changeset/            Independent versioning configuration
.github/workflows/     CI (no automatic publishing)
```

Future feature packages belong in `packages/<slug>`. Ordinary shared libraries can go in `packages/shared`; add them only when there is a real reuse need, rather than creating empty libraries in advance.

## Tooling support boundaries

- The suite generator supports a single YAML patch file, flat `insert` entries, existing-row `disabled: true` overrides with optional name assertions, and plain JSON configuration. It rejects other overrides, groups, relative plugin names, YAML tags (including `!!js`), anchors, and aliases. Unsupported forms produce errors rather than silently dropping fields.
- The bundle validator uses the same restricted patch dialect. Extend the generator, validator, and tests before using more complex DSH features, rather than disabling checks.
- The current release dependency policy supports registry SemVer ranges. After packing, `workspace:`, local paths, Git/URL dependencies, and other non-SemVer dependency declarations are rejected. Explicitly extend the policy first if other sources are needed.
- The validator checks resource existence and basic formats; it is not a complete DSH Loader or image renderer. Host self-referencing entry points require explicit exports; full wildcard and custom-condition resolution is not implemented.
- Distribution tests temporarily generate two disabled-by-default fixtures from the template, compile and pack them, then install a standalone plugin and a suite offline outside the repository to verify that runtime dependencies resolve. This is not equivalent to actual DSH activation, migration, or UI validation.

## Required checks before publishing

- Replace the suite's example package name, `@arkli/dsh-suite`, with a name you have permission to publish; feature package scopes are specified explicitly in the creation command.
- The initial DSH range is exactly `0.2.3-alpha.2`, not a promise of compatibility with other versions; verify it again during development.
- Preserve the feature packages' MIT licenses and third-party notices, and set the intended repository URL.
- Align `baseBranch` in `.changeset/config.json` with the actual default branch (`main` by default).
- Do not publish nonfunctional scaffold packages.
- Pass all checks with `pnpm check && pnpm check:pack`, then perform isolated DSH validation as described in the [development guide](docs/plugin-development.md).

There are no automatic publishing scripts or credential configuration. Publishing, Git pushes, and profile changes require an explicit decision by the maintainer.
