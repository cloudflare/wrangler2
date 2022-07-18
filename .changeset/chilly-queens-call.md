---
"wrangler": minor
---

Initial implementation of `wrangler generate`

- `wrangler generate` and `wrangler generate <name>` delegate to `wrangler init`.
- `wrangler generate <name> <template>` delegates to `create-cloudflare`

Naming behavior is replicated from wrangler 1, and will auto-increment the
worker name based on pre-existing directories.
