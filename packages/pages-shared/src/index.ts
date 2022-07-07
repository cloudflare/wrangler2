import { OkResponse, NotModifiedResponse, PermanentRedirectResponse, NotFoundResponse, MethodNotAllowedResponse, InternalServerErrorResponse } from "./responses"

export type HandlerOptions = {
	get: (url: string) => Promise<Response>
	find: (url: string) => string | null
	applyHeaders?: (request: Request, response: Response) => Response
	applyRedirects?: (request: Request) => Response | null
}

type ServeAssetOptions = Pick<HandlerOptions, 'get'> & {
	request: Request
	found: string | null
	waitUntil?: ExecutionContext['waitUntil']
	options?: { preserve: true }
}

const ASSET_PRESERVATION_CACHE = 'assetPreservationCache'
const CACHE_CONTROL_BROWSER = "public, max-age=0, must-revalidate"; // have the browser check in with the server to make sure its local cache is valid before using it
const CACHE_CONTROL_PRESERVATION = "public, s-maxage=604800"; // 1 week

type HandlerContext = {
	request: Request
	waitUntil?: ExecutionContext['waitUntil']
}

async function serveAsset({ get, found: assetKey, request, waitUntil, options = { preserve: true } }: ServeAssetOptions) {
	// https://support.cloudflare.com/hc/en-us/articles/218505467-Using-ETag-Headers-with-Cloudflare
	// FL sometimes removes etags unless they are wrapped in quotes
	const etag = `"${assetKey}"`;
	const weakEtag = `W/${etag}`;

	const ifNoneMatch = request.headers.get("if-none-match");

	// FL sometimes downgrades our strong etag to a weak one, so we need to check for both
	if (ifNoneMatch === weakEtag || ifNoneMatch === etag) {
		return new NotModifiedResponse();
	}

	try {
		const { body, headers: initialHeaders } = await get(
			assetKey
		)
		const headers: HeadersInit = {
			etag,
			"content-type": initialHeaders.get('content-type') ?? 'application/octet-stream'
		}

		const response = new OkResponse(request.method === "HEAD" ? null : body, {
			headers
		})

		if (isCacheable(request)) {
			response.headers.append("cache-control", CACHE_CONTROL_BROWSER)
		}

		if (options.preserve && waitUntil != undefined) {
			// https://fetch.spec.whatwg.org/#null-body-status
			const preservedResponse = new Response(
				[101, 204, 205, 304].includes(response.status)
					? null
					: response.clone().body,
				response
			);
			preservedResponse.headers.set(
				"cache-control",
				CACHE_CONTROL_PRESERVATION
			)

			//TODO: check whether this should occur
			preservedResponse.headers.set("x-robots-tag", "noindex");

			waitUntil(
				caches
					.open(ASSET_PRESERVATION_CACHE)
					.then((assetPreservationCache) =>
						assetPreservationCache.put(request.url, preservedResponse)
					)
			);
		}

		return response;
	} catch (err) {
		return new InternalServerErrorResponse(err);
	}
}

async function notFound(request: Request, pathname: string, handlerOptions: HandlerOptions) {
	const assetPreservationCache = await caches.open(ASSET_PRESERVATION_CACHE)
	const preservedResponse = await assetPreservationCache.match(request.url)
	if (preservedResponse) {
		return preservedResponse
	}

	// Traverse upwards from the current path looking for a custom 404 page
	let cwd = pathname
	let found;

	while (cwd) {
		cwd = cwd.slice(0, cwd.lastIndexOf('/'))

		if ((found = handlerOptions.find(`${cwd}/404.html`))) {
			//TODO: in production deal with encoding (negotiateEncoding method)
			try {
				const { body, headers } = await handlerOptions.get(found)
				const response = new NotFoundResponse(body)
				response.headers.set('content-type', headers.get('content-type') ?? 'application/octet-stream')
				return response
			} catch (err) {
				return new InternalServerErrorResponse(err)
			}
		}
	}
}

export async function handle(options: HandlerOptions) {
	const {
		applyHeaders = (res) => res,
		applyRedirects = () => null
	} = options;
	async function handler(context: HandlerContext) {
		const {
			request
		} = context;
		const url = new URL(request.url);
		let pathname = url.pathname;
		const search = url.search;

		const redirect = applyRedirects(request);
		if (redirect) {
			return redirect;
		}

		if (!request.method.match(/^(get|head)$/i)) {
			return new MethodNotAllowedResponse()
		}

		try {
			pathname = decodeURIComponent(pathname);
		} catch (_) { }

		let found: string | null;
		if (pathname.endsWith('/')) {
			if ((found = options.find(`${pathname}index.html`))) {
				return serveAsset({ get: options.get, found, request, waitUntil: context.waitUntil?.bind(context) })
			} else if (pathname.endsWith('/index/')) {
				return new PermanentRedirectResponse(`/${pathname.slice(1 - 'index/'.length)}${search}`)
			} else if ((found = options.find(pathname.replace(/\/$/, '.html')))) {
				return new PermanentRedirectResponse(`/${pathname.slice(1, -1)}${search}`)
			} else {
				return notFound(request, pathname, options)
			}
		}

		if ((found = options.find(`${pathname}/index.html`))) {
			return new PermanentRedirectResponse(`${pathname}/${search}`)
		} else {
			return notFound(request, pathname, options)
		}
	}
	return async function (context: HandlerContext) {
		const response = await handler(context);
		return applyHeaders(context.request, response);
	};
}

function isCacheable(request: Request) {
	return !request.headers.has("authorization") && !request.headers.has("range");
}