# Model OAuth authorization

Owner-only browser RPC for registered model sign-in flows. This independent Host plugin leaves the official settings controller enabled and uses the existing DSH authorization, credentials, gateway, and Typert services.

## Installation and assembly

Install this bundle into a Web profile alongside the model OAuth adapter and UI. The patch inserts `arkli-model-oauth-authorization`; it does not replace any official plugin. Enable only one provider of the `authorization` RPC namespace. Target API version: DSH `0.2.3-alpha.2`.

The Host entry registers its own RPC descriptors through `ctx.typert.remotes`. Client plugins import `@arkli/dsh-model-oauth-authorization/remote`, mount its default contribution with `ctx.remote.$mount`, and import browser-safe messages from `/types`. No generated Harness build files or checkout paths are required.

## Behavior and failures

`authorization.list()` exposes only `oauth` methods under the `llm-pi-ai` credential scope and returns redacted saved-record status. `authorization.begin(key, method)` returns a bidirectional stream of notices, prompts, withdrawals, and final outcomes. Reply ids belong to that stream. Account, connector, and API-key methods are excluded. Both endpoints require an owner principal even if another access policy grants permission.

Only HTTP(S) notice links are forwarded. Provider failures return `authorization/failed` without provider error text. Credentials are committed by the authorization service, never returned through these endpoints. Stream cancellation, peer disconnect, and plugin disposal abort active conversations; the authorization service owns final credential commit and flow settlement.

## Development

Run `pnpm build`, `pnpm typecheck`, and `pnpm test` in this package after workspace installation. Build outputs are ordinary JavaScript and declarations in `dist/`. Tests use real Cordis, authorization, gateway, and Typert services with isolated in-memory credentials and no provider network calls.

See `NOTICE` and `LICENSE` for DeepSeek source attribution.
