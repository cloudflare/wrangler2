---
"wrangler": patch
---

feat: `config.first_party_worker` + dev facade

This introduces configuration for marking a worker as a "first party" worker, to be used inside cloudflare to develop workers. It also adds a facade that's applied for first party workers in dev.
