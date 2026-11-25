# Plugin suite

This package installs the [model OAuth replacement](../model-oauth/README.md), including its adapter, owner-only authorization RPC, and replacement Models settings UI. It assembles feature packages without copying their implementation.

## Maintenance

Add the desired `packages/<directory>` entries to `suite.config.json` at the repository root, in the required order, then run:

```sh
pnpm suite:generate
pnpm install --ignore-scripts
pnpm check
pnpm check:pack
```

The generator updates this package's patch and workspace dependencies without copying feature implementations. Do not edit the generated patch manually. When adding features, update this README and both English and Chinese descriptions.

## Installation and migration

After implementation and verification, use DSH's Plugins → Add plugin to select this package directory, or install its published package name. The repository root is not a bundle.

Exactly one enabled bundle should own the assembly of a given feature. Disable overlapping standalone bundles before enabling this suite; disable the suite before migrating back to standalone bundles. Preserve stable plugin row IDs and verify configuration and lifecycle migration in an isolated profile. Do not assume duplicate IDs are automatically deduplicated.

## Compatibility and publication

The manifest targets exactly DSH `0.2.3-alpha.2`. Follow the feature's configuration migration and rollback instructions before switching an existing profile. Real provider login and inference require credentials and separate verification; package tests do not establish provider account eligibility.

`@arkli/dsh-suite` is a provisional publication name. Before publishing, replace it with a scope you control, confirm the license, and validate the packed artifacts. Nothing is published or installed automatically.

The icon is original geometric artwork created for this repository; it uses no third-party brand assets.
