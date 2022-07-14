import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { URLSearchParams } from "node:url";
import tmp from "tmp-promise";
import { bundleWorker } from "./bundle";
import { printBundleSize } from "./bundle-reporter";
import { fetchListResult, fetchResult } from "./cfetch";
import { printBindings } from "./config";
import { createWorkerUploadForm } from "./create-worker-upload-form";
import { confirm } from "./dialogs";
import { getMigrationsToUpload } from "./durable";
import { logger } from "./logger";
import { ParseError } from "./parse";
import { syncAssets } from "./sites";
import { getZoneForRoute } from "./zones";
import type { Config } from "./config";
import type {
	Route,
	ZoneIdRoute,
	ZoneNameRoute,
	CustomDomainRoute,
} from "./config/environment";
import type { Entry } from "./entry";
import type { AssetPaths } from "./sites";
import type { CfWorkerInit } from "./worker";

type Props = {
	config: Config;
	accountId: string | undefined;
	entry: Entry;
	rules: Config["rules"];
	name: string | undefined;
	env: string | undefined;
	compatibilityDate: string | undefined;
	compatibilityFlags: string[] | undefined;
	assetPaths: AssetPaths | undefined;
	triggers: string[] | undefined;
	routes: string[] | undefined;
	legacyEnv: boolean | undefined;
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	tsconfig: string | undefined;
	isWorkersSite: boolean;
	minify: boolean | undefined;
	nodeCompat: boolean | undefined;
	outDir: string | undefined;
	dryRun: boolean | undefined;
	noBundle: boolean | undefined;
};

type RouteObject = ZoneIdRoute | ZoneNameRoute | CustomDomainRoute;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderRoute(route: Route): string {
	let result = "";
	if (typeof route === "string") {
		result = route;
	} else {
		result = route.pattern;
		const isCustomDomain = Boolean(
			"custom_domain" in route && route.custom_domain
		);
		if (isCustomDomain && "zone_id" in route) {
			result += ` (custom domain - zone id: ${route.zone_id})`;
		} else if (isCustomDomain && "zone_name" in route) {
			result += ` (custom domain - zone name: ${route.zone_name})`;
		} else if (isCustomDomain) {
			result += ` (custom domain)`;
		} else if ("zone_id" in route) {
			result += ` (zone id: ${route.zone_id})`;
		} else if ("zone_name" in route) {
			result += ` (zone name: ${route.zone_name})`;
		}
	}
	return result;
}

// this function takes a string with quotes in it
// (i.e. `hello "world", if that really is your name`)
// and peels out the first instance of a substring
// bounded by quotes (so, in the example above, `world`)
//
// this is useful because the /domains api will return
// which domains conflicted in an error message, bounded
// by a string, which we can use to provide helpful
// messages to a user
function getQuoteBoundedSubstring(content: string) {
	const matches = content.split('"');
	return matches[1] ?? "";
}

function isOriginConflictError(
	e: unknown
): e is { code: 100116; message: string; notes: Array<{ text: string }> } {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as { code: number }).code === 100116
	);
}

function isDNSConflictError(
	e: unknown
): e is { code: 100117; message: string; notes: Array<{ text: string }> } {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as { code: number }).code === 100117
	);
}

// empty error class to throw and then explicitly catch via `instanceof`
class CustomDomainOverrideRejected extends Error {}

// publishing to custom domains involves a few more steps than just updating
// the routing table, and thus the api implementing it is fairly defensive -
// it will error eagerly on conflicts against existing domains or existing
// managed DNS records
//
// however, you can pass params to override the errors. we start on the
// defensive path, and if one of these errors occur, we prompt the user
// for confirmation that they do indeed want to override the conflicts, and
// then retry the request with the right override added
//
// if a user does not confirm that they want to override, we skip publishing
// to these custom domains, but continue on through the rest of the
// publish stage
function publishCustomDomains(
	workerUrl: string,
	domains: Array<RouteObject>
): Promise<string[]> {
	const config = {
		override_scope: true,
		override_existing_origin: false,
		override_existing_dns_record: false,
	};
	const origins = domains.map((domainRoute) => {
		return {
			hostname: domainRoute.pattern,
			zone_id: "zone_id" in domainRoute ? domainRoute.zone_id : undefined,
			zone_name: "zone_name" in domainRoute ? domainRoute.zone_name : undefined,
		};
	});

	if (!process.stdout.isTTY) {
		// running in non-interactive mode.
		// existing origins / dns records are not indicative of errors,
		// so we aggressively update rather than aggressively fail
		config.override_existing_origin = true;
		config.override_existing_dns_record = true;
	}

	// Mixing promise chains with async/await is funky, but it allows us to keep related
	// logic synchronous-looking (i.e. prompting for confirmation and then re-requesting)
	// while retaining the flexibility of promise chain fall-throughs. We can group error
	// handling logic in dedicated catch calls, and all we have to do is re-throw an
	// error and it will pass down to the next catch call
	return fetchResult(`${workerUrl}/domains`, {
		method: "PUT",
		body: JSON.stringify({ ...config, origins }),
		headers: {
			"Content-Type": "application/json",
		},
	})
		.catch(async (err) => {
			if (isOriginConflictError(err)) {
				const conflictingOrigins = getQuoteBoundedSubstring(err.notes[0].text);
				const shouldContinue = await confirm(
					`Custom Domains already exist for these domains: "${conflictingOrigins}"\nUpdate them to point to this script instead?`
				);
				if (!shouldContinue) {
					throw new CustomDomainOverrideRejected();
				}
				config.override_existing_origin = true;
				await fetchResult(`${workerUrl}/domains`, {
					method: "PUT",
					body: JSON.stringify({ ...config, origins }),
					headers: {
						"Content-Type": "application/json",
					},
				});
			} else {
				throw err;
			}
		})
		.catch(async (err) => {
			if (isDNSConflictError(err)) {
				const conflictingOrigins = getQuoteBoundedSubstring(err.notes[0].text);
				const shouldContinue = await confirm(
					`You already have conflicting DNS records for these domains: "${conflictingOrigins}"\nUpdate them to point to this script instead?`
				);
				if (!shouldContinue) {
					throw new CustomDomainOverrideRejected();
				}
				config.override_existing_dns_record = true;
				await fetchResult(`${workerUrl}/domains`, {
					method: "PUT",
					body: JSON.stringify({ ...config, origins }),
					headers: {
						"Content-Type": "application/json",
					},
				});
			} else {
				throw err;
			}
		})
		.then(() => domains.map((domain) => renderRoute(domain)))
		.catch((err) => {
			if (err instanceof CustomDomainOverrideRejected) {
				return [
					domains.length > 1
						? `Publishing to ${domains.length} Custom Domains was skipped, fix conflicts and try again`
						: `Publishing to Custom Domain "${domains[0].pattern}" was skipped, fix conflict and try again`,
				];
			}
			throw err;
		});
}

export default async function publish(props: Props): Promise<void> {
	// TODO: warn if git/hg has uncommitted changes
	const { config, accountId } = props;

	if (!(props.compatibilityDate || config.compatibility_date)) {
		const compatibilityDateStr = `${new Date().getFullYear()}-${(
			new Date().getMonth() + ""
		).padStart(2, "0")}-${(new Date().getDate() + "").padStart(2, "0")}`;

		throw new Error(`A compatibility_date is required when publishing. Add the following to your wrangler.toml file:.
    \`\`\`
    compatibility_date = "${compatibilityDateStr}"
    \`\`\`
    Or you could pass it in your terminal as \`--compatibility-date ${compatibilityDateStr}\`
See https://developers.cloudflare.com/workers/platform/compatibility-dates for more information.`);
	}

	const triggers = props.triggers || config.triggers?.crons;
	const routes =
		props.routes ?? config.routes ?? (config.route ? [config.route] : []) ?? [];
	const routesOnly: Array<Route> = [];
	const customDomainsOnly: Array<RouteObject> = [];
	for (const route of routes) {
		if (typeof route !== "string" && route.custom_domain) {
			if (route.pattern.includes("*")) {
				throw new Error(
					`Cannot use "${route.pattern}" as a Custom Domain; wildcard operators (*) are not allowed`
				);
			}
			if (route.pattern.includes("/")) {
				throw new Error(
					`Cannot use "${route.pattern}" as a Custom Domain; paths are not allowed`
				);
			}
			customDomainsOnly.push(route);
		} else {
			routesOnly.push(route);
		}
	}

	// deployToWorkersDev defaults to true only if there aren't any routes defined
	const deployToWorkersDev = config.workers_dev ?? routes.length === 0;

	const jsxFactory = props.jsxFactory || config.jsx_factory;
	const jsxFragment = props.jsxFragment || config.jsx_fragment;

	const minify = props.minify ?? config.minify;

	const nodeCompat = props.nodeCompat ?? config.node_compat;
	if (nodeCompat) {
		logger.warn(
			"Enabling node.js compatibility mode for built-ins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details."
		);
	}

	const scriptName = props.name;
	assert(
		scriptName,
		'You need to provide a name when publishing a worker. Either pass it as a cli arg with `--name <name>` or in your config file as `name = "<name>"`'
	);

	assert(
		!config.site || config.site.bucket,
		"A [site] definition requires a `bucket` field with a path to the site's assets directory."
	);

	if (props.outDir) {
		// we're using a custom output directory,
		// so let's first ensure it exists
		mkdirSync(props.outDir, { recursive: true });
		// add a README
		const readmePath = path.join(props.outDir, "README.md");
		writeFileSync(
			readmePath,
			`This folder contains the built output assets for the worker "${scriptName}" generated at ${new Date().toISOString()}.`
		);
	}

	const destination = props.outDir ?? (await tmp.dir({ unsafeCleanup: true }));
	const envName = props.env ?? "production";

	const start = Date.now();
	const notProd = Boolean(!props.legacyEnv && props.env);
	const workerName = notProd ? `${scriptName} (${envName})` : scriptName;
	const workerUrl = notProd
		? `/accounts/${accountId}/workers/services/${scriptName}/environments/${envName}`
		: `/accounts/${accountId}/workers/scripts/${scriptName}`;

	let available_on_subdomain; // we'll set this later

	const { format } = props.entry;

	if (
		!props.isWorkersSite &&
		Boolean(props.assetPaths) &&
		format === "service-worker"
	) {
		throw new Error(
			"You cannot use the service-worker format with an `assets` directory yet. For information on how to migrate to the module-worker format, see: https://developers.cloudflare.com/workers/learning/migrating-to-module-workers/"
		);
	}

	if (config.wasm_modules && format === "modules") {
		throw new Error(
			"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"
		);
	}

	if (config.text_blobs && format === "modules") {
		throw new Error(
			"You cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}

	if (config.data_blobs && format === "modules") {
		throw new Error(
			"You cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}
	try {
		if (props.noBundle) {
			// if we're not building, let's just copy the entry to the destination directory
			const destinationDir =
				typeof destination === "string" ? destination : destination.path;
			mkdirSync(destinationDir, { recursive: true });
			writeFileSync(
				path.join(destinationDir, path.basename(props.entry.file)),
				readFileSync(props.entry.file, "utf-8")
			);
		}

		const {
			modules,
			resolvedEntryPointPath,
			bundleType,
		}: Awaited<ReturnType<typeof bundleWorker>> = props.noBundle
			? // we can skip the whole bundling step and mock a bundle here
			  {
					modules: [],
					resolvedEntryPointPath: props.entry.file,
					bundleType: props.entry.format === "modules" ? "esm" : "commonjs",
					stop: undefined,
			  }
			: await bundleWorker(
					props.entry,
					typeof destination === "string" ? destination : destination.path,
					{
						serveAssetsFromWorker:
							!props.isWorkersSite && Boolean(props.assetPaths),
						jsxFactory,
						jsxFragment,
						rules: props.rules,
						tsconfig: props.tsconfig ?? config.tsconfig,
						minify,
						nodeCompat,
						define: config.define,
						checkFetch: false,
					}
			  );

		const content = readFileSync(resolvedEntryPointPath, {
			encoding: "utf-8",
		});

		// durable object migrations
		const migrations = !props.dryRun
			? await getMigrationsToUpload(scriptName, {
					accountId,
					config,
					legacyEnv: props.legacyEnv,
					env: props.env,
			  })
			: undefined;

		const assets = await syncAssets(
			accountId,
			// When we're using the newer service environments, we wouldn't
			// have added the env name on to the script name. However, we must
			// include it in the kv namespace name regardless (since there's no
			// concept of service environments for kv namespaces yet).
			scriptName + (!props.legacyEnv && props.env ? `-${props.env}` : ""),
			props.assetPaths,
			false,
			props.dryRun
		);

		const bindings: CfWorkerInit["bindings"] = {
			kv_namespaces: (config.kv_namespaces || []).concat(
				assets.namespace
					? { binding: "__STATIC_CONTENT", id: assets.namespace }
					: []
			),
			vars: config.vars,
			wasm_modules: config.wasm_modules,
			text_blobs: {
				...config.text_blobs,
				...(assets.manifest &&
					format === "service-worker" && {
						__STATIC_CONTENT_MANIFEST: "__STATIC_CONTENT_MANIFEST",
					}),
			},
			data_blobs: config.data_blobs,
			durable_objects: config.durable_objects,
			r2_buckets: config.r2_buckets,
			services: config.services,
			worker_namespaces: config.worker_namespaces,
			logfwdr: config.logfwdr,
			unsafe: config.unsafe?.bindings,
		};

		if (assets.manifest) {
			modules.push({
				name: "__STATIC_CONTENT_MANIFEST",
				content: JSON.stringify(assets.manifest),
				type: "text",
			});
		}

		const worker: CfWorkerInit = {
			name: scriptName,
			main: {
				name: path.basename(resolvedEntryPointPath),
				content: content,
				type: bundleType,
			},
			bindings,
			migrations,
			modules,
			compatibility_date: props.compatibilityDate ?? config.compatibility_date,
			compatibility_flags:
				props.compatibilityFlags ?? config.compatibility_flags,
			usage_model: config.usage_model,
		};

		void printBundleSize(
			{ name: path.basename(resolvedEntryPointPath), content: content },
			modules
		);

		const withoutStaticAssets = {
			...bindings,
			kv_namespaces: config.kv_namespaces,
			text_blobs: config.text_blobs,
		};
		printBindings(withoutStaticAssets);

		if (!props.dryRun) {
			// Upload the script so it has time to propagate.
			// We can also now tell whether available_on_subdomain is set
			const result = await fetchResult<{
				available_on_subdomain: boolean;
				id: string | null;
				etag: string | null;
				pipeline_hash: string | null;
			}>(
				workerUrl,
				{
					method: "PUT",
					body: createWorkerUploadForm(worker),
				},
				new URLSearchParams({
					include_subdomain_availability: "true",
					// pass excludeScript so the whole body of the
					// script doesn't get included in the response
					excludeScript: "true",
				})
			);

			available_on_subdomain = result.available_on_subdomain;

			// Print some useful information returned after publishing
			// Not all fields will be populated for every worker
			// These fields are likely to be scraped by tools, so do not rename
			if (result.id) logger.log("Worker ID: ", result.id);
			if (result.etag) logger.log("Worker ETag: ", result.etag);
			if (result.pipeline_hash)
				logger.log("Worker PipelineHash: ", result.pipeline_hash);
		}
	} finally {
		if (typeof destination !== "string") {
			// this means we're using a temp dir,
			// so let's clean up before we proceed
			await destination.cleanup();
		}
	}

	if (props.dryRun) {
		logger.log(`--dry-run: exiting now.`);
		return;
	}
	assert(accountId, "Missing accountId");

	const uploadMs = Date.now() - start;
	const deployments: Promise<string[]>[] = [];

	if (deployToWorkersDev) {
		// Deploy to a subdomain of `workers.dev`
		const userSubdomain = await getSubdomain(accountId);
		const scriptURL =
			props.legacyEnv || !props.env
				? `${scriptName}.${userSubdomain}.workers.dev`
				: `${envName}.${scriptName}.${userSubdomain}.workers.dev`;
		if (!available_on_subdomain) {
			// Enable the `workers.dev` subdomain.
			deployments.push(
				fetchResult(`${workerUrl}/subdomain`, {
					method: "POST",
					body: JSON.stringify({ enabled: true }),
					headers: {
						"Content-Type": "application/json",
					},
				})
					.then(() => [scriptURL])
					// Add a delay when the subdomain is first created.
					// This is to prevent an issue where a negative cache-hit
					// causes the subdomain to be unavailable for 30 seconds.
					// This is a temporary measure until we fix this on the edge.
					.then(async (url) => {
						await sleep(3000);
						return url;
					})
			);
		} else {
			deployments.push(Promise.resolve([scriptURL]));
		}
	} else {
		if (available_on_subdomain) {
			// Disable the workers.dev deployment
			await fetchResult(`${workerUrl}/subdomain`, {
				method: "POST",
				body: JSON.stringify({ enabled: false }),
				headers: {
					"Content-Type": "application/json",
				},
			});
		}
	}

	logger.log("Uploaded", workerName, formatTime(uploadMs));

	// Update routing table for the script.
	if (routesOnly.length > 0) {
		deployments.push(
			publishRoutes(routesOnly, { workerUrl, scriptName, notProd }).then(() => {
				if (routesOnly.length > 10) {
					return routesOnly
						.slice(0, 9)
						.map((route) => renderRoute(route))
						.concat([`...and ${routesOnly.length - 10} more routes`]);
				}
				return routesOnly.map((route) => renderRoute(route));
			})
		);
	}

	// Update custom domains for the script
	if (customDomainsOnly.length > 0) {
		deployments.push(publishCustomDomains(workerUrl, customDomainsOnly));
	}

	// Configure any schedules for the script.
	// TODO: rename this to `schedules`?
	if (triggers && triggers.length) {
		deployments.push(
			fetchResult(`${workerUrl}/schedules`, {
				// Note: PUT will override previous schedules on this script.
				method: "PUT",
				body: JSON.stringify(triggers.map((cron) => ({ cron }))),
				headers: {
					"Content-Type": "application/json",
				},
			}).then(() => triggers.map((trigger) => `schedule: ${trigger}`))
		);
	}

	const targets = await Promise.all(deployments);
	const deployMs = Date.now() - start - uploadMs;

	if (deployments.length > 0) {
		logger.log("Published", workerName, formatTime(deployMs));
		for (const target of targets.flat()) {
			logger.log(" ", target);
		}
	} else {
		logger.log("No publish targets for", workerName, formatTime(deployMs));
	}
}

function formatTime(duration: number) {
	return `(${(duration / 1000).toFixed(2)} sec)`;
}

async function getSubdomain(accountId: string): Promise<string> {
	try {
		const { subdomain } = await fetchResult(
			`/accounts/${accountId}/workers/subdomain`
		);
		return subdomain;
	} catch (e) {
		const error = e as { code?: number };
		if (typeof error === "object" && !!error && error.code === 10007) {
			// 10007 error code: not found
			// https://api.cloudflare.com/#worker-subdomain-get-subdomain

			const errorMessage =
				"Error: You need to register a workers.dev subdomain before publishing to workers.dev";
			const solutionMessage =
				"You can either publish your worker to one or more routes by specifying them in wrangler.toml, or register a workers.dev subdomain here:";
			const onboardingLink = `https://dash.cloudflare.com/${accountId}/workers/onboarding`;

			throw new Error(`${errorMessage}\n${solutionMessage}\n${onboardingLink}`);
		} else {
			throw e;
		}
	}
}

/**
 * Associate the newly deployed Worker with the given routes.
 */
async function publishRoutes(
	routes: Route[],
	{
		workerUrl,
		scriptName,
		notProd,
	}: { workerUrl: string; scriptName: string; notProd: boolean }
): Promise<string[]> {
	try {
		return await fetchResult(`${workerUrl}/routes`, {
			// Note: PUT will delete previous routes on this script.
			method: "PUT",
			body: JSON.stringify(
				routes.map((route) =>
					typeof route !== "object" ? { pattern: route } : route
				)
			),
			headers: {
				"Content-Type": "application/json",
			},
		});
	} catch (e) {
		if (isAuthenticationError(e)) {
			// An authentication error is probably due to a known issue,
			// where the user is logged in via an API token that does not have "All Zones".
			return await publishRoutesFallback(routes, { scriptName, notProd });
		} else {
			throw e;
		}
	}
}

/**
 * Try updating routes for the Worker using a less optimal zone-based API.
 *
 * Compute match zones to the routes, then for each route attempt to connect it to the Worker via the zone.
 */
async function publishRoutesFallback(
	routes: Route[],
	{ scriptName, notProd }: { scriptName: string; notProd: boolean }
) {
	if (notProd) {
		throw new Error(
			"Service environments combined with an API token that doesn't have 'All Zones' permissions is not supported.\n" +
				"Either turn off service environments by setting `legacy_env = true`, creating an API token with 'All Zones' permissions, or logging in via OAuth"
		);
	}
	logger.warn(
		"The current authentication token does not have 'All Zones' permissions.\n" +
			"Falling back to using the zone-based API endpoint to update each route individually.\n" +
			"Note that there is no access to routes associated with zones that the API token does not have permission for.\n" +
			"Existing routes for this Worker in such zones will not be deleted."
	);

	const deployedRoutes: string[] = [];

	// Collect the routes (and their zones) that will be deployed.
	const activeZones = new Map<string, string>();
	const routesToDeploy = new Map<string, string>();
	for (const route of routes) {
		const zone = await getZoneForRoute(route);
		if (zone) {
			activeZones.set(zone.id, zone.host);
			routesToDeploy.set(
				typeof route === "string" ? route : route.pattern,
				zone.id
			);
		}
	}

	// Collect the routes that are already deployed.
	const allRoutes = new Map<string, string>();
	const alreadyDeployedRoutes = new Set<string>();
	for (const [zone, host] of activeZones) {
		try {
			for (const { pattern, script } of await fetchListResult<{
				pattern: string;
				script: string;
			}>(`/zones/${zone}/workers/routes`)) {
				allRoutes.set(pattern, script);
				if (script === scriptName) {
					alreadyDeployedRoutes.add(pattern);
				}
			}
		} catch (e) {
			if (isAuthenticationError(e)) {
				e.notes.push({
					text: `This could be because the API token being used does not have permission to access the zone "${host}" (${zone}).`,
				});
			}
			throw e;
		}
	}

	// Deploy each route that is not already deployed.
	for (const [routePattern, zoneId] of routesToDeploy.entries()) {
		if (allRoutes.has(routePattern)) {
			const knownScript = allRoutes.get(routePattern);
			if (knownScript === scriptName) {
				// This route is already associated with this worker, so no need to hit the API.
				alreadyDeployedRoutes.delete(routePattern);
				continue;
			} else {
				throw new Error(
					`The route with pattern "${routePattern}" is already associated with another worker called "${knownScript}".`
				);
			}
		}

		const { pattern } = await fetchResult(`/zones/${zoneId}/workers/routes`, {
			method: "POST",
			body: JSON.stringify({
				pattern: routePattern,
				script: scriptName,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		});

		deployedRoutes.push(pattern);
	}

	if (alreadyDeployedRoutes.size) {
		logger.warn(
			"Previously deployed routes:\n" +
				"The following routes were already associated with this worker, and have not been deleted:\n" +
				[...alreadyDeployedRoutes.values()].map((route) => ` - "${route}"\n`) +
				"If these routes are not wanted then you can remove them in the dashboard."
		);
	}

	return deployedRoutes;
}

function isAuthenticationError(e: unknown): e is ParseError {
	return e instanceof ParseError && (e as { code?: number }).code === 10000;
}
