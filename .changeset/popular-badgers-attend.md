---
"wrangler": patch
---

feat: send durable object migrations with `wrangler dev`

This sends up migrations even during `wrangler dev`. This means features like renamed / deleted classes should work as expected even during development.

Fixes https://github.com/cloudflare/wrangler2/issues/736
