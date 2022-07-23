---
"wrangler": patch
---

feat: add cache control options to `config.assets`

This adds cache control options to `config.assets`. This is already supported by the backing library (`@cloudflare/kv-asset-handler`) so we simply pass on the options at its callsite.

Additionally, this adds a configuration field to serve an app in "single page app" mode, where a root index.html is served for all html/404 requests (also powered by the same library).
