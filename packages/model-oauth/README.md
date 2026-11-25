# Model OAuth replacement

An installable replacement for the built-in pi-ai adapter and Models settings page in DSH `0.2.3-alpha.2`. The existing **Settings → Models** entry, API-key/custom-provider controls, onboarding, and provider OAuth interaction remain on the Models page. This package is an independent personal-fork implementation, not an official DeepSeek release.

## Assembly

The bundle disables `llm-pi-ai` and `ui-settings-models`, then inserts:

| Row | Responsibility |
| --- | --- |
| `arkli-model-oauth-adapter` | pi-ai 1.6.0 model catalog, requests, credentials, and provider authorization flows |
| `arkli-model-oauth-authorization` | Owner-only authorization RPC, using the official authorization and credential services |
| `arkli-model-oauth-ui` | Replacement Models settings page and onboarding |

The official settings controller stays enabled. The adapter depends on `@arkli/pi-ai-patched`, whose published runtime includes the Gemini thought-signature patch; users do not need a pnpm patch or installation script. Existing `llm-pi-ai/<provider>` credential records and the OpenAI device ID location are retained. The replacement UI mounts its own authorization RPC descriptors without modifying the official API package.

## Installation

Build the workspace with `pnpm install --ignore-scripts && pnpm build`. Distribute the feature and its internal dependencies as packed packages, or publish the verified packages under a scope you control. The repository root is not an installable bundle. No packages are published automatically.

Once the packages are available, install `@arkli/dsh-model-oauth` through the DSH plugin manager, or use `dsh plugin --profile <profile> add @arkli/dsh-model-oauth`. Use a Web profile based on the official base and Web bundles. Restart the profile after installation so replacement and dependency loading complete together.

Enable either this standalone bundle or `@arkli/dsh-suite`, never both. Do not combine it with another replacement of these rows or another provider of the `authorization` RPC namespace, including the source-modified OAuth version of DSH. The target is the unmodified official implementation.

## Existing configuration and rollback

DSH stores settings against Loader row IDs. The adapter's new settings namespace is `arkli-model-oauth-adapter`, not `llm-pi-ai`. Installation does not copy, delete, or overwrite saved model configuration. Existing credential records are reused, but configured provider routes must be migrated or added again on the Models page.

For a configuration maintained in a profile patch, copy the complete `config` from the old `llm-pi-ai` entry into an override for `arkli-model-oauth-adapter`. Omit the old `name` assertion or replace it with `@arkli/dsh-model-oauth-adapter`. Copy any `ui-settings-models` deployment configuration, such as `credentialOnboarding`, to `arkli-model-oauth-ui` in the same way. Preserve the old overrides for rollback; they remain inactive while their original rows are disabled. Avoid putting literal credentials in YAML: retain credential references.

Disable or remove the replacement bundle and restart to return to the official adapter and UI. The original configuration remains available. Edits made under the replacement namespace do not automatically flow back; copy supported settings explicitly if needed. New pi-ai catalog routes or grants are not guaranteed to work with the older official adapter. Keep credential records unless you intend to sign out.

## Compatibility and security

The package pins DSH APIs to `0.2.3-alpha.2`; it does not promise compatibility with other releases. OAuth runs on the DSH host. Provider callback listeners, external authorization pages, credentials, and account eligibility remain subject to the selected provider's requirements. Browser interaction is owner-only; other principals cannot list or run these flows. Provider errors are redacted by the RPC controller.

Tests use local fixtures and do not sign into real provider accounts. Real account login and inference require separate verification with the intended provider. The bundle icon is original geometric artwork.

## Validation

The packed replacement was installed in an isolated Web profile running the unmodified official npm `@deepseek-ai/dsh@0.2.3-alpha.2`. The Models settings entry and OAuth selector rendered, and the owner authorization-list endpoint returned nine provider flows successfully. No existing credentials or daily profile were used. The isolated runtime's default-workspace creation failed independently of the Models checks; session creation was not validated. Local evidence is retained in `.artifacts/web-validation/` outside published packages.
