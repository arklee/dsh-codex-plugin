# DSH Plugin Monorepo Development Guidelines

## Project goals

This repository is intended for developing a collection of DeepSeek Harness (DSH) plugins:

- Maintain all plugins in a single Git monorepo.
- Allow each feature to be installed as an independent npm package and DSH bundle.
- Provide an aggregate suite bundle for installing the entire collection at once.
- Allow future scenario-specific bundles without duplicating feature implementations.

This document describes the target architecture; it does not imply that the directories, tooling, or features already exist. Inspect the repository before making changes, and do not perform unrelated migrations just to match the example structure. `@arkli` is an example scope; confirm the actual namespace and your publication permissions before publishing.

## Local reference source repositories

When inspecting related implementations, prefer these local source directories (`~` denotes the current user's home directory):

- DeepSeek Harness (DSH): `~/Code/agent-playground/deepseek-harness`
- pi: `~/Code/agent-playground/pi`

These are reference source repositories, not this plugin monorepo. Confirm that each directory exists and check its version before using it. When verifying DSH behavior, also confirm that the source matches the target runtime version. Permission to inspect source does not authorize changes to these repositories. Do not include reference source paths in plugin runtime dependencies or published artifacts.

## Default technology choices

- Use pnpm workspaces to manage the monorepo and commit a shared lockfile.
- Prefer TypeScript and ESM.
- Use Changesets for independent versioning and release notes.
- Do not introduce Nx, Turborepo, or a custom plugin framework initially; add infrastructure only for a concrete need.
- Set the root package to `private: true`; it is not a DSH installation entry point.
- Build published packages ahead of time; do not depend on compilation during user installation.

## Target directory structure

```text
packages/
  codex/                 # Example feature package
    package.json
    cordis.patch.yml
    src/
      index.ts           # Host entry
      client.ts          # Optional UI entry
    dist/                # Build output
    locale/
    docs/
    icon.svg
    tests/
  git-tools/             # Example feature; create only when needed
  notes/                 # Example feature; create only when needed
  shared/                # Optional ordinary shared library
  suite/                 # Aggregate bundle; no feature implementation
scripts/
  generate-suite.ts      # Implement aggregate assembly generation as needed
  check-packages.ts      # Implement package and artifact validation as needed
tests/
  integration/
.changeset/
```

Feature names are examples only. Do not create empty plugins without a corresponding request.

## Package responsibilities and boundaries

### Feature packages

Each feature package provides:

1. The plugin implementation and required runtime exports.
2. An independent installation entry declared through `dsh.bundle.patch`.
3. A default assembly patch.
4. Localized titles and descriptions, an icon, and necessary usage documentation.
5. Unit tests and integration checks relevant to the feature.

Use a consistent prefix for plugin package names, such as `@arkli/dsh-codex`. Loader row IDs must be stable and namespaced, such as `arkli-codex`. Do not encode versions or local paths in IDs.

A feature may require multiple Host/Client assembly records. A single feature package is not necessarily limited to one plugin row.

### Aggregate bundles

The suite only declares dependencies and assembles plugins. It must not copy feature code or implement cross-plugin business logic.

- Declare included feature packages in `dependencies`.
- Explicitly declare aggregate assembly in the suite's own `dsh.bundle.patch`.
- Do not assume that dependency bundles' patches execute recursively.
- Do not rely on root-level hoisting or undeclared dependencies.
- Every published package must resolve its declared runtime dependencies outside the monorepo.

### Shared code

- Extract shared libraries only when there is a real reuse requirement.
- Put ordinary functions, types, and protocols in shared libraries, or bundle them into feature packages as needed.
- Use explicit provider plugins and Cordis injection for shared runtime state or services.
- npm dependency relationships are not Cordis runtime assembly relationships.
- Optional integrations must not force an independent feature to depend on the entire suite.
- Circular package dependencies are not allowed.
- Do not import another package's source through paths such as `../../other-plugin/src`; use explicit package exports.

## DSH development rules

### Confirm the current version and APIs first

DSH plugin protocols may change between versions. Before development, upgrades, or troubleshooting:

1. Load and follow the `dsh-doc` skill if it is available in the current environment.
2. Prefer `cordis_inspect` to confirm the running version, services, events, configuration schemas, and relevant Client extension points.
3. Confirm manifest, assembly, and build requirements against the documentation and source for the installed version.
4. Do not guess APIs from memory or use another version's implementation as evidence of current behavior.

The version checked during the architecture discussion was `0.2.3-alpha.2`; this is not a permanent compatibility promise. Reconfirm the target version before setting `engines.dsh`. Prerelease compatibility ranges must retain appropriate prerelease suffixes, and you must not claim untested compatibility.

### Manifests and published contents

Every installable bundle must declare `dsh.bundle.patch` and ensure that it points to a file actually included in the published package.

- Host entry exports must point to real build output.
- Declare Client entries and build artifacts according to current DSH requirements; Host exports do not replace a Client manifest.
- Preserve runtime exports and provide the required locale and icon exports.
- Use `files` to explicitly include build output, patches, locales, icons, and documentation resources.
- Provide English and Chinese `meta.title` and `meta.description` values that accurately describe the implementation.
- Provide original icons or icons licensed for redistribution, with any required attribution.
- Supply optional detail documents and preview resources according to current DSH requirements; do not invent capabilities.
- Publicly published packages must not set `private: true`; the root package and unpublished development tools should set it.

### Lifecycle and configuration

- Use a Host export form supported by the current DSH version; do not mix mutually exclusive forms.
- Bind tool, event, UI, and other resource registrations to the plugin lifecycle and dispose of them through the corresponding APIs.
- Hot reload and disable operations must not leave listeners, background tasks, or duplicate UI registrations behind.
- Validate configuration against its schema. Use `config: {}` only for plugins that allow empty configuration.
- Keep credentials out of source, default patches, test snapshots, and logs; use DSH-supported configuration and credential mechanisms.
- Read existing patches before editing them. Treat a `config` override as a complete replacement, not a deep merge.

## Assembly sources and generation

A feature package's default patch is the source of truth for its default assembly. Prefer deterministic build-time generation of the suite patch to avoid maintaining duplicate assembly declarations by hand.

The generator must:

- Explicitly list included feature packages rather than relying on unstable scan order.
- Preserve stable row IDs and required assembly information.
- Validate duplicate IDs, missing dependencies, and unsupported patch forms.
- Prefer npm package names when referencing plugins.
- Handle path anchors correctly; do not simply concatenate patches containing relative paths and assume their meaning is unchanged.
- Parse YAML properly rather than concatenating it as arbitrary text; do not corrupt DSH tags or expressions.
- Produce reproducible output and check in CI that generated files match their source declarations.

Until complex overrides, nested groups, or expressions are supported, explicitly reject them rather than silently dropping fields. Mark generated files with their sources and do not edit them manually.

## Standalone and suite installation

The initial design uses an explicit assembly ownership rule:

> Within one profile, exactly one enabled bundle owns the assembly of a given feature.

- Support enabling a standalone feature bundle or providing that feature through the suite.
- Disable overlapping standalone bundles before migrating to the suite.
- Remove overlapping assembly when migrating from the suite back to standalone bundles.
- Use the same stable row IDs for a feature in standalone and suite assembly.
- Matching IDs do not imply deduplication; do not rely on unverified duplicate-insertion behavior.
- Do not work around conflicts by using different IDs, which could execute the feature twice.
- Feature toggles in the suite must respect service dependencies. Do not disable a provider and still claim its dependent features are usable.

Arbitrary mixed installation, automatic migration, and reference counting for shared features require separate design and testing. Do not assume npm dependency deduplication solves runtime assembly problems.

## Versioning and publication

- Version feature packages independently; unrelated plugin changes must not force synchronized upgrades.
- Version the suite independently to represent a verified combination of features.
- Use `workspace:*` for internal dependencies and convert them into distributable versions through the proper pnpm packing/publication workflow.
- Initially prefer exact feature versions in the suite for reproducible installation.
- When a feature version changes, check whether the suite's dependencies and release notes also need updates.
- Use Changesets to record user-visible changes, breaking changes, and migration requirements.
- Inspect actual tarballs before publishing, not just workspace directories.
- Do not publish to npm, push Git tags, or perform an official release without explicit user authorization.

## Testing and quality gates

Run the repository's relevant existing checks after changes. Read the actual scripts first instead of assuming commands exist. When introducing tooling, add consistent build, typecheck, test, and package-validation commands.

Minimum coverage requirements:

1. Each feature package builds and tests independently.
2. Published packages contain all manifest-declared entries and required resources.
3. Individual features install from packed artifacts in a clean environment without depending on the repository root.
4. The suite resolves its dependencies and assembles every declared feature.
5. Disable, reload, and re-enable operations do not duplicate tool, event, or UI registrations.
6. Migration between standalone and suite installations follows the ownership rules.
7. Required services, optional integrations, and incomplete configuration have verified behavior.
8. The aggregate patch matches the default assembly of its feature packages.
9. UI changes are verified on the actual DSH page; successful installation or slot registration is not visual verification.

Use isolated test environments or profiles whenever possible. Do not modify the user's daily profile without permission. Report why any tests could not be run and the remaining risks; never report unexecuted checks as passed.

## Interacting with the DSH environment

- Designing, reviewing, or generating documentation does not authorize plugin installation or profile changes.
- When the user explicitly requests installation, prefer the DSH `plugin_manager` workflow.
- Do not bypass plugin management by manually editing profile dependencies or patches.
- Do not approve dependency installation scripts or bypass compatibility checks without explicit user approval.
- For local development installation, select a specific feature package or suite directory, not the private monorepo root.
- The DSH source checkout may differ from this repository. Do not turn plugin development into unauthorized Harness core changes.
- Confirm build and HMR conditions before changing Client code; do not promise automatic updates without verification.

## Agent working practices

- Write repository documentation and README templates in English. Keep localized UI resources in their respective languages.
- Read relevant code and documentation before editing, and follow existing conventions.
- Keep changes focused. Do not perform unrelated tooling migrations, package renames, or feature refactors.
- Do not overwrite user changes or commit secrets, user configuration, or local absolute paths.
- Explain the purpose of new dependencies and prefer existing capabilities.
- Treat package names, row IDs, configuration fields, and exports as compatibility interfaces; provide migration guidance when changing them.
- For changes spanning multiple packages, specify the implementation order, compatibility impact, and validation scope.
- On completion, report what changed, what was verified, what remains unverified, and whether installation, reload, or migration is required.
