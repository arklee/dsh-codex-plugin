---
"@arkli/dsh-model-oauth": minor
"@arkli/dsh-model-oauth-adapter": minor
"@arkli/dsh-model-oauth-authorization": minor
"@arkli/dsh-model-oauth-ui": minor
"@arkli/pi-ai-patched": patch
"@arkli/dsh-suite": minor
---

Add an independently installable model OAuth replacement with pi-ai 1.6.0, packaged Gemini signature replay support, owner-only authorization RPC, and the existing Models settings entry. The suite now includes the replacement. Existing model settings must be copied from `llm-pi-ai` to `arkli-model-oauth-adapter`; credential keys remain unchanged. Enable only one assembly owner per profile.
