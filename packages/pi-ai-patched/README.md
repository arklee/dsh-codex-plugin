# pi-ai with Gemini signature replay

Redistributable pi-ai `1.6.0` runtime with the Gemini OpenAI-compatible thought-signature fix used by the model OAuth replacement. This is an independently named MIT-licensed derivative, not an upstream pi release.

`pnpm build` copies the pinned upstream npm package's `dist/` and applies `gemini-signature.patch` with zero fuzz. An unexpected upstream version or patch mismatch fails the build. The published package contains the patched JavaScript, declarations, model data, and all required runtime dependency declarations. Consumers need no patch configuration or lifecycle scripts; the upstream pi-ai package is a build-time development dependency only.

The patch retains `tool_calls[].extra_content.google.thought_signature` on streamed tool calls and restores it when replaying those calls. OpenAI's encrypted reasoning detail format is not treated as a Gemini signature. Public subpath exports match upstream pi-ai 1.6.0.

Copyright (c) 2025 Mario Zechner; see [LICENSE](LICENSE). The patch is adapted from the DeepSeek Harness personal fork at `fb864b014045e55ce8c0a200d5e99c591add4fac`, under its MIT license. Build requires the `patch` utility; installation does not.
