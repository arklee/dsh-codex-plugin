# Plugin suite

This package is the aggregate installation entry for the repository's explicit plugin list. **The list is currently empty; it provides no Codex, Git, or other business functionality.** It prepares the repository for future combined distribution. Do not publish the empty suite to npm.

## Maintenance

Add the desired `packages/<directory>` entries to `suite.config.json` at the repository root, in the required order, then run:

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

The generator updates this package's patch and workspace dependencies without copying feature implementations. Do not edit the generated patch manually. When adding real features, update this README and both English and Chinese descriptions, remove the empty-suite notices, and accurately list the capabilities provided.

## Installation and migration

After implementation and verification, use DSH's Plugins → Add plugin to select this package directory, or install its published package name. The repository root is not a bundle.

Exactly one enabled bundle should own the assembly of a given feature. Disable overlapping standalone bundles before enabling this suite; disable the suite before migrating back to standalone bundles. Preserve stable plugin row IDs and verify configuration and lifecycle migration in an isolated profile. Do not assume duplicate IDs are automatically deduplicated.

## Compatibility and publication

The initial manifest targets exactly DSH `0.2.3-alpha.2`. This was the target version when the infrastructure was created; actual plugin execution and GUI behavior have not been verified. Reconfirm the APIs and compatibility after adding business functionality.

`@arkli/dsh-suite` is a provisional publication name. Before publishing, replace it with a scope you control, confirm the license, and validate the packed artifacts. Nothing is published or installed automatically.

The icon is original geometric artwork created for this repository; it uses no third-party brand assets.
