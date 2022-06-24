---
"wrangler": patch
---

feat: support `--assets` for service-worker Workers

This adds support for `--assets` for service-worker Workers. We do this similarly to how we implement support for module workers (using a facade), but here's the difference - we have to to hijack `addEventListener()` to capture fetch event handlers, so we can call them after checking whether we need to serve a static asset request first. Conveniently, we can use esbuild's `define`+`inject` to hijack the event listener and redirect to our implementation (see `sw-asset-facade-addEventListener.js`).
