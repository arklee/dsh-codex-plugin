# Model sign-in

An independent Host + Web Client bundle for stock DSH `0.2.3-alpha.2`. It exposes the OAuth methods registered under the host's `llm-pi-ai` credential scope in Settings. It does not supply an OAuth client, provider catalog, API keys or model routes, and does not install or upgrade pi-ai.

In Plugins → Add plugin, select **this directory**, not the repository root, or enable the suite instead. In Settings, open **Model sign-in** as the owner. Choose a provider, follow its verification link or prompt, and keep the section open until sign-in completes. Then open **Models**, select the matching catalog provider, and save it without an API-key override. The plugin never overwrites existing model settings.

For ChatGPT/Codex on stock DSH with pi-ai 1.3.0, use the **`openai-codex`** catalog route, not `openai`. The stock adapter also registers OAuth methods for providers such as Anthropic and GitHub Copilot. The list is discovered at runtime; an adapter that offers only an API-key method for a route cannot be made OAuth-capable by this UI.

**Before signing in**, ensure every route using the same provider ID (including other profiles sharing the credential store) targets the provider's trusted endpoint. When the host exposes its model settings, the plugin excludes routes with endpoint, protocol, key-reference or nonempty header overrides and checks again when sign-in starts. Stock DSH does not contain the fork's same-origin guard at request time. Use a distinct route ID for gateways: a settings check cannot protect another profile or a route edited after login.

Credentials and refreshes remain with DSH. Disabling the plugin removes the sign-in UI, not stored grants or provider-side consent. To revoke consent, use the provider's account controls. No migration of stored records is required. Do not enable standalone and suite assembly at the same time.
