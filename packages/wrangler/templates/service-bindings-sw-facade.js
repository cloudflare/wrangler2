import "__ENTRY_POINT__";
const Workers = __WORKERS__;

// For every Worker definition that's available,
// create a fetcher for it on the facade env.
for (const [name, details] of Object.entries(Workers)) {
	if (details) {
		globalThis[name] = {
			async fetch(...reqArgs) {
				if (details.headers) {
					const req = new Request(...reqArgs);
					for (const [key, value] of Object.entries(details.headers)) {
						// In remote mode, you need to add a couple of headers
						// to make sure it's talking to the 'dev' preview session
						// (much like wrangler dev already does via proxy.ts)
						req.headers.set(key, value);
					}
					return env[name].fetch(req);
				}
				const url = `${details.protocol}://${details.host}${
					details.port ? `:${details.port}` : ""
				}`;
				const request = new Request(url, ...reqArgs);
				return fetch(request);
			},
		};
	} else {
		// This means it's a local mode binding
		// but hasn't started up locally yet.
		globalThis[name] = {
			async fetch() {
				return new Response(
					`You should start up wrangler dev --local on the ${name} worker`,
					{ status: 404 }
				);
			},
		};
	}
}
