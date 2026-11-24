# Model sign-in

An owner-only Host + Web Client bundle for stock DSH `0.2.3-alpha.2`. It includes an independent OpenAI subscription adapter powered by pi-ai **1.6.0**, without replacing or upgrading the host's adapter.

1. In Plugins → Add plugin, select **this directory**, not the repository root, or enable the suite instead.
2. Open Settings → **Model sign-in**, select **OpenAI (ChatGPT)** and choose **Sign in and enable**. Follow the verification link and keep the settings page open until completion. If the browser callback does not complete, paste the final callback URL into the private prompt on this page.
3. In the chat model picker choose **OpenAI (ChatGPT) → GPT-6.2 Astra** (`arkli-openai/gpt-6.2-astra`), or another advertised model. **No Models settings entry or API key is needed.** Availability for inference depends on the account. The same grant restores the route after restart.

The new route has its own grant, official endpoint and device ID. Existing `openai` gateways, legacy `openai-codex` grants and saved model choices are not modified or imported. When upgrading, sign in once to **OpenAI (ChatGPT)** and switch the chat model. Do not select **OpenAI Codex (legacy)** for this workflow. Disabling the plugin removes its route and UI, not the saved grant or provider-side consent. Re-enable it to restore the route; revoke consent in the provider's account controls.

### Other host-provided sign-in methods

Stock OAuth methods (such as Anthropic, GitHub Copilot and legacy Codex) remain separate. For these, sign in here, then add the matching catalog provider in **Models** without an API-key override. Ensure every profile sharing that credential uses only trusted catalog endpoints. The sign-in UI checks current settings but cannot protect a stock adapter's later request if another profile changes an endpoint.

Do not enable standalone and suite assembly at the same time. The Host request/stream bridge is adapted from MIT-licensed DeepSeek Harness (commit `ed77a65860`); see `host/bridge/LICENSE.deepseek`. Only the OpenAI OAuth provider is mounted by this bundle.
