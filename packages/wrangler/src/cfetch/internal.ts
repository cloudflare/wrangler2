import assert from "node:assert";
import { fetch, Headers } from "undici";
import { version as wranglerVersion } from "../../package.json";
import { getEnvironmentVariableFactory } from "../environment-variables";
import { ParseError, parseJSON } from "../parse";
import { loginOrRefreshIfRequired, requireApiToken } from "../user";
import type { ApiCredentials } from "../user";
import type { URLSearchParams } from "node:url";
import type { RequestInit, HeadersInit, Response } from "undici";

/**
 * Get the URL to use to access the Cloudflare API.
 */
export const getCloudflareAPIBaseURL = getEnvironmentVariableFactory({
	variableName: "CLOUDFLARE_API_BASE_URL",
	deprecatedName: "CF_API_BASE_URL",
	defaultValue: "https://api.cloudflare.com/client/v4",
});

/**
 * 	Builds and makes the fetch request.
 *  Allows raw response access, to handle non-json responses.
 */
export async function fetchInternalResponse(
	resource: string,
	init: RequestInit = {},
	queryParams?: URLSearchParams,
	abortSignal?: AbortSignal
): Promise<Response> {
	await requireLoggedIn();
	const apiToken = requireApiToken();
	const headers = cloneHeaders(init.headers);
	addAuthorizationHeaderIfUnspecified(headers, apiToken);
	addUserAgent(headers);

	const queryString = queryParams ? `?${queryParams.toString()}` : "";
	const method = init.method ?? "GET";
	return fetch(`${getCloudflareAPIBaseURL()}${resource}${queryString}`, {
		method,
		...init,
		headers,
		signal: abortSignal,
	});
}

/**
 * Make a fetch request to the Cloudflare API.
 *
 * This function handles acquiring the API token and logging the caller in, as necessary.
 *
 * Check out https://api.cloudflare.com/ for API docs.
 *
 * This function should not be used directly, instead use the functions in `cfetch/index.ts`.
 */
export async function fetchInternal<ResponseType>(
	resource: string,
	init: RequestInit = {},
	queryParams?: URLSearchParams,
	abortSignal?: AbortSignal
): Promise<ResponseType> {
	assert(
		resource.startsWith("/"),
		`CF API fetch - resource path must start with a "/" but got "${resource}"`
	);
	const internalResponse = await fetchInternalResponse(
		resource,
		init,
		queryParams,
		abortSignal
	);
	return handleResponseAsJSON(resource, init, internalResponse);
}

export async function handleResponseAsJSON<ResponseType>(
	resource: string,
	init: RequestInit,
	response: Response
) {
	const jsonText = await response.text();
	try {
		return parseJSON<ResponseType>(jsonText);
	} catch (err) {
		throw new ParseError({
			text: "Received a malformed response from the API",
			notes: [
				{
					text: truncate(jsonText, 100),
				},
				{
					text: `${init.method ?? "GET"} ${resource} -> ${response.status} ${
						response.statusText
					}`,
				},
			],
		});
	}
}

function truncate(text: string, maxLength: number): string {
	const { length } = text;
	if (length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}... (length = ${length})`;
}

function cloneHeaders(
	headers: HeadersInit | undefined
): Record<string, string> {
	return headers instanceof Headers
		? Object.fromEntries(headers.entries())
		: Array.isArray(headers)
		? Object.fromEntries(headers)
		: { ...headers };
}

async function requireLoggedIn(): Promise<void> {
	const loggedIn = await loginOrRefreshIfRequired();
	if (!loggedIn) {
		throw new Error("Not logged in.");
	}
}

function addAuthorizationHeaderIfUnspecified(
	headers: Record<string, string>,
	auth: ApiCredentials
): void {
	if (!("Authorization" in headers)) {
		if ("apiToken" in auth) {
			headers["Authorization"] = `Bearer ${auth.apiToken}`;
		} else {
			headers["X-Auth-Key"] = auth.authKey;
			headers["X-Auth-Email"] = auth.authEmail;
		}
	}
}

function addUserAgent(headers: Record<string, string>): void {
	headers["User-Agent"] = `wrangler/${wranglerVersion}`;
}

/**
 * The implementation for fetching a kv value from the cloudflare API.
 * We special-case this one call, because it's the only API call that
 * doesn't return json. We inline the implementation and try not to share
 * any code with the other calls. We should push back on any new APIs that
 * try to introduce non-"standard" response structures.
 *
 * Note: any calls to fetchKVGetValue must call encodeURIComponent on key
 * before passing it
 */

export async function fetchKVGetValue(
	accountId: string,
	namespaceId: string,
	key: string
): Promise<ArrayBuffer> {
	await requireLoggedIn();
	const auth = requireApiToken();
	const headers: Record<string, string> = {};
	addAuthorizationHeaderIfUnspecified(headers, auth);
	const resource = `${getCloudflareAPIBaseURL()}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;
	const response = await fetch(resource, {
		method: "GET",
		headers,
	});
	if (response.ok) {
		return await response.arrayBuffer();
	} else {
		throw new Error(
			`Failed to fetch ${resource} - ${response.status}: ${response.statusText});`
		);
	}
}
