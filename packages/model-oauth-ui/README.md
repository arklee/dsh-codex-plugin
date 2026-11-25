# Model OAuth UI

Replacement Models settings UI for DeepSeek Harness `0.2.3-alpha.2`. Install it through the model OAuth bundle, which replaces the official Models UI row and provides the authorization remote. Do not enable both Models UI plugins in one profile.

The adapter settings namespace is `arkli-model-oauth-adapter`; existing `llm-pi-ai` configuration requires an explicit migration through the replacement bundle configuration. No automatic migration is performed. Credential flow keys remain `llm-pi-ai/<provider>` so existing grants remain addressable.

The `models` settings section, `settings.models` locale and child-slot namespaces, welcome notice, DeepSeek onboarding, and `credentialOnboarding` configuration are preserved. OAuth uses the sibling `@arkli/dsh-model-oauth-authorization` remote. The Client mounts its RPC contribution on the plugin lifecycle before registering the Models UI in a child scope that requires `remote.authorization`; API-key and custom-provider editing retain the official services.

## Build

Run `pnpm --filter @arkli/dsh-model-oauth-ui build` after workspace dependencies and the authorization package declarations are available. `typecheck` checks the complete copied UI. The package-local esbuild and lightningcss build emits a Host ESM entry and a browser module-loader factory with deferred stylesheet metadata; React and shared DSH UI modules resolve through the shell module table. No reference checkout is needed to build or run the package. After building, run `pnpm --filter @arkli/dsh-model-oauth-ui test` to check the emitted factory, deferred stylesheets, authorization-before-UI ordering, and mount failure handling. These artifact checks do not substitute for browser interaction tests.

## Attribution

The UI sources, styles, and locale resources derive from `packages/client/ui-settings-models` in the personal DeepSeek Harness `feature/model-oauth` branch at `fb864b014045e55ce8c0a200d5e99c591add4fac` (`0.2.3-alpha.2`). Copyright (c) 2026 DeepSeek, redistributed under the MIT license in [LICENSE](LICENSE). This is an independent personal-fork package, not an official DeepSeek release.
