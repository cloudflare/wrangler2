---
"wrangler": patch
---

feat: zero config multiworker development (local mode)

Preamble: Typically, a Worker has been the _unit_ of a javascript project on our platform. Any logic that you need, you fit into one worker, ~ 1MB of javascript and bindings. If you wanted to deploy a larger application, you could define different workers on different routes. This is fine for microservice style architectures, but not all projects can be cleaved along the route boundaries; you lose out on sharing code and resources, and can still cross the size limit with heavy dependencies.

Service bindings provide a novel mechanism for composing multiple workers into a unified architecture. You could deploy shared code into a worker, and make requests to it from another worker. This lets you architect your code along functional boundaries, while also providing some relief to the 1MB size limit.

I propose a model for developing multiple bound workers in a single project.

Consider Worker A, at `workers/a.js`, with a `wrangler.toml` like so:

```toml
name = 'A'

[[services]]
binding = 'Bee'
service = 'B'
```

and content like so:

```js
export default {
	fetch(req, env) {
		return env.Bee.fetch(req);
	},
};
```

Consider Worker B, at `workers/b.js`, with a `wrangler.toml` like so:

```toml
name = 'B'
```

and content like so:

```js
export default {
	fetch(req, env) {
		return new Response("Hello World");
	},
};
```

So, a worker A, bound to B, that simply passes on the request to B.

## Local mode:

Currently, when I run `wrangler dev --local` on A (or switch from remote to local mode during a dev session), and make requests to A, they'll fail because the bindings don't exist in local mode.

What I'd like, is to be able to run `wrangler dev --local` on B as well, and have my dev instance of A make requests to the dev instance of B. When I'm happy with my changes, I'd simply deploy both workers (again, ideally as a batched publish).

## Proposal: A local dev registry for workers.

- Running `wrangler dev` on a machine should start up a local service registry (if there isn't one loaded already) as a server on a well known port.
- Further, it should then "register" itself with the registry with metadata about itself; whether it's running in remote/local mode, the port and ip its dev server is listening on, and any additional configuration (eg: in remote mode, a couple of extra headers have to be added to every request made to the dev session, so we'd add that data into the registry as well.)
- Every worker that has service bindings configured, should intercept requests to said binding, and instead make a request to the locally running instance of the service. It could rewrite these requests as it pleases.

(In future PRs, we'll introduce a system for doing the same with remote mode dev, as well as mixed mode. )

Related to https://github.com/cloudflare/wrangler2/issues/1182
Fixes https://github.com/cloudflare/wrangler2/issues/1040
