---
"wrangler": patch
---

feat: Adds the `--experimental-enable-local-persistence` option to `wrangler pages dev`

Previously, this was implicitly enabled and stored things in a `.mf` directory. Now we move to be in line with what `wrangler dev` does, defaults disabled, and stores in a `wrangler-local-state` directory.
