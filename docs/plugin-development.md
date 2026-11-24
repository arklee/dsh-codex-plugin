# Plugin development guide

## 1. Define plugin boundaries

Split packages by user-facing capability, not by individual utility function. For example, a Codex integration can include the necessary Host services, tools, and Client UI while still shipping as a single independent feature package.

- npm packages handle code distribution and versioning.
- DSH bundle patches handle runtime assembly.
- The suite only combines features; it contains no feature implementation.
- Put ordinary shared functions in shared libraries; use providers and Cordis injection for runtime services.

Do not make one plugin depend on another entire plugin just to reuse a function. Do not assume that a provider has been mounted merely because it appears in the dependencies.

## 2. Create a development scaffold

Run from the repository root (replace the scope and target version):

```sh
pnpm create:plugin codex --scope your-scope --dsh-version 0.2.3-alpha.2
pnpm install --ignore-scripts
```

This generates `packages/codex`:

- `src/index.ts`: a Host entry point with a named `apply` export, currently an empty implementation.
- `package.json`: ESM exports, a bundle patch, locale/icon exports, and a list of files to publish.
- `tsconfig.json`: inherits the root configuration and compiles source files to `dist`.
- `cordis.patch.yml`: mounts the package itself using a stable row ID, with `disabled: true` by default.
- `locale/en.json` and `locale/zh.json`: explicitly identify the package as a development scaffold.
- `icon.svg`: an original scaffold icon; replace it with a feature-specific icon once real functionality is implemented.
- `README.md`: development tips and limitations for the package.

The initial version is `0.0.0`. The command requires an explicit scope and does not automatically configure publishing permissions; the names `suite` and `shared` are reserved. Existing paths are not overwritten, and partially created directories are retained for inspection if a write fails.

You can also create a conforming package manually without the scaffold. For Client-only, MCP, or complex service plugins, use the corresponding templates for the target DSH version.

## 3. Implement against actual DSH APIs

Before development, read the `dsh-doc` skill (if the tool environment provides it), and use `cordis_inspect` to query:

1. `Runtime.getVersion`: the actual running version.
2. The exact contracts of the relevant Host Services and Events.
3. For UI plugins, Client slots, props, registration methods, and theme tokens.
4. The plugin's Config schema before changing existing configuration.

The template deliberately omits invented Context types or APIs. Once you have identified the actual services you need, add the corresponding type/runtime dependencies and use a build method supported by the current DSH version. Do not copy a plugin API from another version and assume it will work.

Suggested implementation order:

1. Extract pure business logic into independently testable functions.
2. Connect the confirmed services, tools, or events in the Host entry point.
3. Add a Config schema and document defaults, required fields, and credential management.
4. Bind registrations, timers, and background tasks to the correct lifecycle; verify cleanup after disabling the plugin.
5. Add a Client UI only if needed, without directly manipulating the host DOM.

Creating a UI requires more than renaming an ordinary ESM file to `client.js`. Configure `dsh.client`, the `./client` export, browser module factories, and external module declarations for the target version, and use the appropriate Client build tools. The current scaffold provides only a Host entry point, not a fake UI template.

## 4. Build and test an individual package

```sh
pnpm --filter @your-scope/dsh-codex build
pnpm --filter @your-scope/dsh-codex typecheck
```

Add feature tests and a `test` script to the package itself. The root `pnpm test` runs tooling tests, distribution integration tests, and the tests declared by each package.

During development, you can use TypeScript watch mode:

```sh
pnpm --filter @your-scope/dsh-codex exec tsc -p tsconfig.json --watch
```

This only updates compiled output. It does not mean DSH has reloaded, much less that the Client page has updated.

Once the feature is complete, update:

- The manifest's description, dependencies, exports, and files;
- Titles and descriptions in both locales;
- Usage instructions, configuration, and limitations in the README;
- The icon and license information;
- The patch's default configuration and `disabled` state.

Use `config: {}` only for plugins that allow empty configuration. If you initially keep `disabled: true`, users must explicitly enable the plugin later; the suite preserves this state unchanged.

## 5. Add the plugin to the suite

Edit the root `suite.config.json`:

```json
{
  "packages": [
    "packages/codex"
  ]
}
```

Then run:

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

Generation rules:

- Merge strictly in the order of the configuration array, without relying on directory scan order.
- Feature package patches are the source of truth for default assembly.
- The suite patch is generated; do not edit it directly.
- The generator manages the suite's `workspace:` dependencies; corresponding dependencies are removed when packages leave the list.
- Other manually maintained suite dependencies are preserved. A feature package's direct dependency referenced by a row is promoted to a direct dependency of the suite; conflicts produce errors.
- Duplicate IDs, missing workspace dependencies, circular dependencies, out-of-bounds paths, and unsupported patch forms produce errors.
- The generator supports restricted static forms of `id`, `name`, `config`, `disabled`, `inject`, `intercept`, and `isolate`. Overrides, groups, `!!js`, anchors, aliases, and similar features are unsupported; extend and test the generator first if you need them.

After adding real features, update the suite README and both locales to remove empty-suite descriptions. When multiple packages reuse the same provider, design a single source of assembly ownership. The generator rejects duplicate row IDs rather than guessing which configuration to keep.

## 6. Install and debug in DSH

Infrastructure checks do not install anything automatically. Once the feature is complete, explicitly choose an isolated development profile to avoid affecting everyday sessions.

- In DSH **Plugins → Add plugin**, select the feature package's absolute directory, such as the full path to `packages/codex`.
- Alternatively, explicitly ask the Agent to use `plugin_manager` with `install_bundle`, setting target to the package's absolute path.
- If you need the full set of features, select `packages/suite`.
- Do not select the private repository root.
- Local directory links rely on a workspace with dependencies installed and artifacts built. Published-package validation must use a tarball/registry, not just local links.

Inspect `application`, warnings, and the status of individual plugin rows in the installation result. Do not equate a successful installation with successful feature validation. For rows that require configuration or are disabled by default, complete the configuration before explicitly enabling them.

Under the DSH behavior verified so far, after updating local files and rebuilding, calling `set_plugin` with `enabled: true` for the exact row ID can trigger profile recomposition, even if the row is already enabled. This affects the plugin's enabled state and must be done with explicit debugging intent. Repeating `install_bundle` and receiving already-installed does not count as a reload. Recheck these behaviors for later DSH versions.

Whether Client updates use HMR depends on the actual environment's build watchers and HMR conditions. The current scaffold does not promise automatic refresh and does not start a replacement DSH server.

## 7. Migrate between standalone and suite installations

Within a profile, only one enabled bundle should provide the assembly for a given feature:

- Standalone plugin → suite: record the current configuration, disable overlapping standalone plugin bundles, then install/enable the suite.
- Suite → standalone plugins: disable the suite, then install/enable the standalone plugin bundles you need.
- Keep stable row IDs for the same feature, but do not treat matching IDs as automatic deduplication.
- Test whether user configuration is preserved, required providers remain available, and tools or listeners are registered more than once.

Current automated tests validate assembly-file generation/removal and standalone tarball dependency resolution, not migration behavior inside DSH. Actual migration, activation, deactivation, and UI behavior must be validated on the target DSH version.

## 8. Publishing and versioning

Feature packages use independent versions. The suite has its own independent version representing a verified combination.

```sh
pnpm changeset
pnpm version:packages
pnpm check
pnpm check:pack
```

A changeset should describe feature changes. When the dependency combination or the suite's default assembly changes, check whether the suite also needs a changeset. `pnpm pack` converts `workspace:*` to concrete versions; package checks reject unconverted workspace and local dependencies.

Before publishing, manually confirm:

- npm scope permissions, package names, licenses, and repository metadata;
- The default branch and Changesets `baseBranch`;
- Real functionality is complete: do not publish scaffolds or an empty suite;
- The tested `engines.dsh` range;
- Tarballs contain all runtime resources and no credentials;
- Actual DSH validation is complete for standalone installation, suite installation, lifecycle behavior, and UI.

Publish only after explicit maintainer approval. For example, you can use Changesets' publishing capability, but this repository deliberately has no automatic publishing workflow or automatic push command. Feature packages must have available published versions before the aggregate package can be installed successfully outside the repository.

## Validation boundaries

`pnpm check:pack` checks actual packaged resources and supported dependency forms; it is not comprehensive static dependency analysis. Any new runtime import still requires testing in a clean consumer environment or the target DSH instance. Icon checks cover only basic format and size, not actual rendering. The current template registers no runtime resources, so tests of its empty `apply` cannot prove that a feature plugin releases resources correctly.
