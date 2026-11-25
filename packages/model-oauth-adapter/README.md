# Model OAuth adapter

Replacement for DSH's pi-ai adapter, used by [`@arkli/dsh-model-oauth`](../model-oauth/README.md). It uses pi-ai 1.6.0, enables the provider-native OAuth flows including OpenAI device registration, and retains the Gemini OpenAI-compatible tool signature roundtrip.

Mount only through the replacement bundle. The Loader row `arkli-model-oauth-adapter` owns configuration, while credential records remain under `llm-pi-ai/<provider>`. A bare mount registers the configurable provider catalog but no inference routes. The Models page writes provider configuration to the replacement row. Explicit credential references take precedence over provider-native authorization.

The implementation derives from DeepSeek Harness `packages/llm/llm-pi-ai` at commit `fb864b014045e55ce8c0a200d5e99c591add4fac`, with pi-ai imports redirected to the independently packaged patched runtime. Copyright (c) 2026 DeepSeek; see [LICENSE](LICENSE). Settings and credential identifiers intentionally retain their compatibility roles rather than following the npm package name.

`pnpm build` emits ESM and declarations; `pnpm typecheck` checks the adapter, and `pnpm test` runs built-runtime tests. No reference source checkout is required. See the feature README for installation, configuration migration, rollback, and compatibility limits.
