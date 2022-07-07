import { execSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { URL } from "node:url";
import { Response } from "@miniflare/core"
import { watch } from "chokidar";
import { handle } from "../../../pages-shared";
import { getVarsForDev } from "../dev/dev-vars";
import { FatalError } from "../errors";
import { logger } from "../logger";
import { getRequestContextCheckOptions } from "../miniflare-cli/request-context";
import openInBrowser from "../open-in-browser";
import { buildFunctions } from "./build";
import { SECONDS_TO_WAIT_FOR_PROXY } from "./constants";
import { CLEANUP, CLEANUP_CALLBACKS, pagesBetaWarning } from "./utils";
import type { Config } from "../config";
import type {
	fetch as miniflareFetch
} from "@miniflare/core";
import type {
	MiniflareOptions,
	Request as MiniflareRequest,
	Response as MiniflareResponse,
} from "miniflare";
import type { Argv, ArgumentsCamelCase } from "yargs";

type PagesDevArgs = {
	directory?: string;
	command?: string;
	local: boolean;
	port: number;
	proxy?: number;
	"script-path": string;
	binding?: (string | number)[];
	kv?: (string | number)[];
	do?: (string | number)[];
	"live-reload": boolean;
	"node-compat": boolean;
};

export function Options(yargs: Argv): Argv<PagesDevArgs> {
	return yargs
		.positional("directory", {
			type: "string",
			demandOption: undefined,
			description: "The directory of static assets to serve",
		})
		.positional("command", {
			type: "string",
			demandOption: undefined,
			description: "The proxy command to run",
		})
		.options({
			local: {
				type: "boolean",
				default: true,
				description: "Run on my machine",
			},
			port: {
				type: "number",
				default: 8788,
				description: "The port to listen on (serve from)",
			},
			proxy: {
				type: "number",
				description: "The port to proxy (where the static assets are served)",
			},
			"script-path": {
				type: "string",
				default: "_worker.js",
				description:
					"The location of the single Worker script if not using functions",
			},
			binding: {
				type: "array",
				description: "Bind variable/secret (KEY=VALUE)",
				alias: "b",
			},
			kv: {
				type: "array",
				description: "KV namespace to bind",
				alias: "k",
			},
			do: {
				type: "array",
				description: "Durable Object to bind (NAME=CLASS)",
				alias: "o",
			},
			"live-reload": {
				type: "boolean",
				default: false,
				description: "Auto reload HTML pages when change is detected",
			},
			"node-compat": {
				describe: "Enable node.js compatibility",
				default: false,
				type: "boolean",
				hidden: true,
			},
			config: {
				describe: "Pages does not support wrangler.toml",
				type: "string",
				hidden: true,
			},
			//   // TODO: Miniflare user options
		})
		.epilogue(pagesBetaWarning);
}

export const Handler = async ({
	local,
	directory,
	port,
	proxy: requestedProxyPort,
	"script-path": singleWorkerScriptPath,
	binding: bindings = [],
	kv: kvs = [],
	do: durableObjects = [],
	"live-reload": liveReload,
	"node-compat": nodeCompat,
	config: config,
	_: [_pages, _dev, ...remaining],
}: ArgumentsCamelCase<PagesDevArgs>) => {
	// Beta message for `wrangler pages <commands>` usage
	logger.log(pagesBetaWarning);

	if (!local) {
		throw new FatalError("Only local mode is supported at the moment.", 1);
	}

	if (config) {
		throw new FatalError("Pages does not support wrangler.toml", 1);
	}

	const functionsDirectory = "./functions";
	const usingFunctions = existsSync(functionsDirectory);

	const command = remaining as (string | number)[];

	let proxyPort: number | void;

	if (directory === undefined) {
		proxyPort = await spawnProxyProcess({
			port: requestedProxyPort,
			command,
		});
		if (proxyPort === undefined) return undefined;
	}

	let miniflareArgs: MiniflareOptions = {};

	let scriptReadyResolve: () => void;
	const scriptReadyPromise = new Promise<void>(
		(resolve) => (scriptReadyResolve = resolve)
	);

	if (usingFunctions) {
		const outfile = join(tmpdir(), `./functionsWorker-${Math.random()}.js`);

		if (nodeCompat) {
			console.warn(
				"Enabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details."
			);
		}

		logger.log(`Compiling worker to "${outfile}"...`);

		try {
			await buildFunctions({
				outfile,
				functionsDirectory,
				sourcemap: true,
				watch: true,
				onEnd: () => scriptReadyResolve(),
				buildOutputDirectory: directory,
				nodeCompat,
			});
		} catch {}

		watch([functionsDirectory], {
			persistent: true,
			ignoreInitial: true,
		}).on("all", async () => {
			await buildFunctions({
				outfile,
				functionsDirectory,
				sourcemap: true,
				watch: true,
				onEnd: () => scriptReadyResolve(),
				buildOutputDirectory: directory,
				nodeCompat,
			});
		});

		miniflareArgs = {
			scriptPath: outfile,
		};
	} else {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		scriptReadyResolve!();

		const scriptPath =
			directory !== undefined
				? join(directory, singleWorkerScriptPath)
				: singleWorkerScriptPath;

		if (existsSync(scriptPath)) {
			miniflareArgs = {
				scriptPath,
			};
		} else {
			logger.log("No functions. Shimming...");
			miniflareArgs = {
				// cfFetch sets the `cf` object that a function could expect
				// If there are no functions, there's no reason to set this up (and not make that network call)
				cfFetch: false,
				// TODO: The fact that these request/response hacks are necessary is ridiculous.
				// We need to eliminate them from env.ASSETS.fetch (not sure if just local or prod as well)
				script: `
          export default {
            async fetch(request, env, context) {
              const response = await env.ASSETS.fetch(request.url, request)
              return new Response(response.body, response)
            }
          }`,
			};
		}
	}

	// Defer importing miniflare until we really need it
	const { Miniflare, Log, LogLevel } = await import("miniflare");
	const { fetch } = await import("@miniflare/core");

	// Wait for esbuild to finish building before starting Miniflare.
	// This must be before the call to `new Miniflare`, as that will
	// asynchronously start loading the script. `await startServer()`
	// internally just waits for that promise to resolve.
	await scriptReadyPromise;

	// `assetsFetch()` will only be called if there is `proxyPort` defined.
	// We only define `proxyPort`, above, when there is no `directory` defined.
	const assetsFetch =
		directory !== undefined
			? await generateAssetsFetch(directory)
			: invalidAssetsFetch;

	const requestContextCheckOptions = await getRequestContextCheckOptions();

	const vars = getVarsForDev({
		configPath: resolvePath(".dev.vars"),
	} as Config);

	const miniflare = new Miniflare({
		port,
		watch: true,
		modules: true,

		log: new Log(LogLevel.ERROR, { prefix: "pages" }),
		logUnhandledRejections: true,
		sourceMap: true,

		kvNamespaces: kvs.map((kv) => kv.toString()),

		durableObjects: Object.fromEntries(
			durableObjects.map((durableObject) => durableObject.toString().split("="))
		),

		// User bindings
		bindings: {
			...vars,
			...Object.fromEntries(
				bindings
					.map((binding) => binding.toString().split("="))
					.map(([key, ...values]) => [key, values.join("=")])
			),
		},

		// env.ASSETS.fetch
		serviceBindings: {
			async ASSETS(request: MiniflareRequest) {
				if (proxyPort) {
					try {
						const url = new URL(request.url);
						url.host = `localhost:${proxyPort}`;
						return await fetch(url, request);
					} catch (thrown) {
						logger.error(`Could not proxy request: ${thrown}`);

						// TODO: Pretty error page
						return new Response(
							`[wrangler] Could not proxy request: ${thrown}`,
							{ status: 502 }
						);
					}
				} else {
					try {
						return await assetsFetch(request);
					} catch (thrown) {
						logger.error(`Could not serve static asset: ${thrown}`);

						// TODO: Pretty error page
						return new Response(
							`[wrangler] Could not serve static asset: ${thrown}`,
							{ status: 502 }
						);
					}
				}
			},
		},

		kvPersist: true,
		durableObjectsPersist: true,
		cachePersist: true,
		liveReload,

		...requestContextCheckOptions,
		...miniflareArgs,
	});

	try {
		// `startServer` might throw if user code contains errors
		const server = await miniflare.startServer();
		logger.log(`Serving at http://localhost:${port}/`);

		if (process.env.BROWSER !== "none") {
			await openInBrowser(`http://localhost:${port}/`);
		}

		if (directory !== undefined && liveReload) {
			watch([directory], {
				persistent: true,
				ignoreInitial: true,
			}).on("all", async () => {
				await miniflare.reload();
			});
		}

		CLEANUP_CALLBACKS.push(() => {
			server.close();
			miniflare.dispose().catch((err) => miniflare.log.error(err));
		});
	} catch (e) {
		miniflare.log.error(e as Error);
		CLEANUP();
		throw new FatalError("Could not start Miniflare.", 1);
	}
};

function isWindows() {
	return process.platform === "win32";
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function getPids(pid: number) {
	const pids: number[] = [pid];
	let command: string, regExp: RegExp;

	if (isWindows()) {
		command = `wmic process where (ParentProcessId=${pid}) get ProcessId`;
		regExp = new RegExp(/(\d+)/);
	} else {
		command = `pgrep -P ${pid}`;
		regExp = new RegExp(/(\d+)/);
	}

	try {
		const newPids = (
			execSync(command)
				.toString()
				.split("\n")
				.map((line) => line.match(regExp))
				.filter((line) => line !== null) as RegExpExecArray[]
		).map((match) => parseInt(match[1]));

		pids.push(...newPids.map(getPids).flat());
	} catch {}

	return pids;
}

function getPort(pid: number) {
	let command: string, regExp: RegExp;

	if (isWindows()) {
		command = "\\windows\\system32\\netstat.exe -nao";
		regExp = new RegExp(`TCP\\s+.*:(\\d+)\\s+.*:\\d+\\s+LISTENING\\s+${pid}`);
	} else {
		command = "lsof -nPi";
		regExp = new RegExp(`${pid}\\s+.*TCP\\s+.*:(\\d+)\\s+\\(LISTEN\\)`);
	}

	try {
		const matches = execSync(command)
			.toString()
			.split("\n")
			.map((line) => line.match(regExp))
			.filter((line) => line !== null) as RegExpExecArray[];

		const match = matches[0];
		if (match) return parseInt(match[1]);
	} catch (thrown) {
		logger.error(
			`Error scanning for ports of process with PID ${pid}: ${thrown}`
		);
	}
}

async function spawnProxyProcess({
	port,
	command,
}: {
	port?: number;
	command: (string | number)[];
}): Promise<void | number> {
	if (command.length === 0) {
		CLEANUP();
		throw new FatalError(
			"Must specify a directory of static assets to serve or a command to run.",
			1
		);
	}

	logger.log(`Running ${command.join(" ")}...`);
	const proxy = spawn(
		command[0].toString(),
		command.slice(1).map((value) => value.toString()),
		{
			shell: isWindows(),
			env: {
				BROWSER: "none",
				...process.env,
			},
		}
	);
	CLEANUP_CALLBACKS.push(() => {
		proxy.kill();
	});

	proxy.stdout.on("data", (data) => {
		logger.log(`[proxy]: ${data}`);
	});

	proxy.stderr.on("data", (data) => {
		logger.error(`[proxy]: ${data}`);
	});

	proxy.on("close", (code) => {
		logger.error(`Proxy exited with status ${code}.`);
	});

	// Wait for proxy process to start...
	while (!proxy.pid) {}

	if (port === undefined) {
		logger.log(
			`Sleeping ${SECONDS_TO_WAIT_FOR_PROXY} seconds to allow proxy process to start before attempting to automatically determine port...`
		);
		logger.log("To skip, specify the proxy port with --proxy.");
		await sleep(SECONDS_TO_WAIT_FOR_PROXY * 1000);

		port = getPids(proxy.pid)
			.map(getPort)
			.filter((nr) => nr !== undefined)[0];

		if (port === undefined) {
			CLEANUP();
			throw new FatalError(
				"Could not automatically determine proxy port. Please specify the proxy port with --proxy.",
				1
			);
		} else {
			logger.log(`Automatically determined the proxy port to be ${port}.`);
		}
	}

	return port;
}

function escapeRegex(str: string) {
	return str.replace(/[-/\\^$*+?.()|[]{}]/g, "\\$&");
}

type Replacements = Record<string, string>;

function replacer(str: string, replacements: Replacements) {
	for (const [replacement, value] of Object.entries(replacements)) {
		str = str.replace(`:${replacement}`, value);
	}
	return str;
}

function generateRulesMatcher<T>(
	rules?: Record<string, T>,
	replacerFn: (match: T, replacements: Replacements) => T = (match) => match
) {
	// TODO: How can you test cross-host rules?
	if (!rules) return () => [];

	const compiledRules = Object.entries(rules)
		.map(([rule, match]) => {
			const crossHost = rule.startsWith("https://");

			rule = rule.split("*").map(escapeRegex).join("(?<splat>.*)");

			const host_matches = rule.matchAll(
				/(?<=^https:\\\/\\\/[^/]*?):([^\\]+)(?=\\)/g
			);
			for (const hostMatch of host_matches) {
				rule = rule.split(hostMatch[0]).join(`(?<${hostMatch[1]}>[^/.]+)`);
			}

			const path_matches = rule.matchAll(/:(\w+)/g);
			for (const pathMatch of path_matches) {
				rule = rule.split(pathMatch[0]).join(`(?<${pathMatch[1]}>[^/]+)`);
			}

			rule = "^" + rule + "$";

			try {
				const regExp = new RegExp(rule);
				return [{ crossHost, regExp }, match];
			} catch {}
		})
		.filter((value) => value !== undefined) as [
		{ crossHost: boolean; regExp: RegExp },
		T
	][];

	return ({ request }: { request: MiniflareRequest }) => {
		const { pathname, host } = new URL(request.url);

		return compiledRules
			.map(([{ crossHost, regExp }, match]) => {
				const test = crossHost ? `https://${host}${pathname}` : pathname;
				const result = regExp.exec(test);
				if (result) {
					return replacerFn(match, result.groups || {});
				}
			})
			.filter((value) => value !== undefined) as T[];
	};
}

function generateHeadersMatcher(headersFile: string) {
	if (existsSync(headersFile)) {
		const contents = readFileSync(headersFile).toString();

		// TODO: Log errors
		const lines = contents
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => !line.startsWith("#") && line !== "");

		const rules: Record<string, Record<string, string>> = {};
		let rule: { path: string; headers: Record<string, string> } | undefined =
			undefined;

		for (const line of lines) {
			if (/^([^\s]+:\/\/|^\/)/.test(line)) {
				if (rule && Object.keys(rule.headers).length > 0) {
					rules[rule.path] = rule.headers;
				}

				const path = validateURL(line);
				if (path) {
					rule = {
						path,
						headers: {},
					};
					continue;
				}
			}

			if (!line.includes(":")) continue;

			const [rawName, ...rawValue] = line.split(":");
			const name = rawName.trim().toLowerCase();
			const value = rawValue.join(":").trim();

			if (name === "") continue;
			if (!rule) continue;

			const existingValues = rule.headers[name];
			rule.headers[name] = existingValues
				? `${existingValues}, ${value}`
				: value;
		}

		if (rule && Object.keys(rule.headers).length > 0) {
			rules[rule.path] = rule.headers;
		}

		const rulesMatcher = generateRulesMatcher(rules, (match, replacements) =>
			Object.fromEntries(
				Object.entries(match).map(([name, value]) => [
					name,
					replacer(value, replacements),
				])
			)
		);

		return (request: MiniflareRequest) => {
			const matches = rulesMatcher({
				request,
			});
			if (matches) return matches;
		};
	} else {
		return () => undefined;
	}
}

function generateRedirectsMatcher(redirectsFile: string) {
	if (existsSync(redirectsFile)) {
		const contents = readFileSync(redirectsFile).toString();

		// TODO: Log errors
		const lines = contents
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => !line.startsWith("#") && line !== "");

		const rules = Object.fromEntries(
			lines
				.map((line) => line.split(" "))
				.filter((tokens) => tokens.length === 2 || tokens.length === 3)
				.map((tokens) => {
					const from = validateURL(tokens[0], true, false, false);
					const to = validateURL(tokens[1], false, true, true);
					let status: number | undefined = parseInt(tokens[2]) || 302;
					status = [301, 302, 303, 307, 308].includes(status)
						? status
						: undefined;

					return from && to && status ? [from, { to, status }] : undefined;
				})
				.filter((rule) => rule !== undefined) as [
				string,
				{ to: string; status?: number }
			][]
		);

		const rulesMatcher = generateRulesMatcher(
			rules,
			({ status, to }, replacements) => ({
				status,
				to: replacer(to, replacements),
			})
		);

		return (request: MiniflareRequest) => {
			const match = rulesMatcher({
				request,
			})[0];
			if (match) return match;
		};
	} else {
		return () => undefined;
	}
}

function extractPathname(
	path = "/",
	includeSearch: boolean,
	includeHash: boolean
) {
	if (!path.startsWith("/")) path = `/${path}`;
	const url = new URL(`//${path}`, "relative://");
	return `${url.pathname}${includeSearch ? url.search : ""}${
		includeHash ? url.hash : ""
	}`;
}

function validateURL(
	token: string,
	onlyRelative = false,
	includeSearch = false,
	includeHash = false
) {
	const host = /^https:\/\/+(?<host>[^/]+)\/?(?<path>.*)/.exec(token);
	if (host && host.groups && host.groups.host) {
		if (onlyRelative) return;

		return `https://${host.groups.host}${extractPathname(
			host.groups.path,
			includeSearch,
			includeHash
		)}`;
	} else {
		if (!token.startsWith("/") && onlyRelative) token = `/${token}`;

		const path = /^\//.exec(token);
		if (path) {
			try {
				return extractPathname(token, includeSearch, includeHash);
			} catch {}
		}
	}
	return "";
}

async function generateAssetsFetch(
	directory: string
): Promise<typeof miniflareFetch> {
	// Defer importing miniflare until we really need it
	const { Headers, Request } = await import("@miniflare/core");

	const headersFile = join(directory, "_headers");
	const redirectsFile = join(directory, "_redirects");
	const workerFile = join(directory, "_worker.js");

	const ignoredFiles = [headersFile, redirectsFile, workerFile];

	const assetExists = (path: string) => {
		path = join(directory, path);
		return (
			existsSync(path) &&
			lstatSync(path).isFile() &&
			!ignoredFiles.includes(path)
		);
	};

	const getAsset = (path: string) => {
		if (assetExists(path)) {
			return join(directory, path);
		}
		return null;
	};

	let redirectsMatcher = generateRedirectsMatcher(redirectsFile);
	let headersMatcher = generateHeadersMatcher(headersFile);

	watch([headersFile, redirectsFile], {
		persistent: true,
	}).on("change", (path) => {
		switch (path) {
			case headersFile: {
				logger.log("_headers modified. Re-evaluating...");
				headersMatcher = generateHeadersMatcher(headersFile);
				break;
			}
			case redirectsFile: {
				logger.log("_redirects modified. Re-evaluating...");
				redirectsMatcher = generateRedirectsMatcher(redirectsFile);
				break;
			}
		}
	});

	const serveAsset = async (file: string) => {
		const result = readFileSync(file);
		return new Response(result, { status: 200 });
	};

	const generateResponse = async (request: MiniflareRequest) => {
		function applyRedirects(req: MiniflareRequest) {
			const url = new URL(req.url);
			const match = redirectsMatcher(req);
			if (match) {
				const { status, to } = match;

				let location = to;
				let search;

				if (to.startsWith("/")) {
					search = new URL(location, "http://fakehost").search;
				} else {
					search = new URL(location).search;
				}

				location = `${location}${search ? "" : url.search}`;

				let responseStatus = 302;

				if (status && [301, 302, 303, 307, 308].includes(status)) {
					responseStatus = status;
				}

				return new Response(null, {
					status: responseStatus,
					headers: {
						Location: location,
					},
				});
			}
		}
		function applyHeaders(req: MiniflareRequest, res: MiniflareResponse) {
			const headers = res.headers;
			const newHeaders = new Headers({});
			const matches = headersMatcher(req) || [];

			matches.forEach((match) => {
				Object.entries(match).forEach(([name, value]) => {
					newHeaders.append(name, `${value}`);
				});
			});

			const combinedHeaders = {
				...Object.fromEntries(headers.entries()),
				...Object.fromEntries(newHeaders.entries()),
			};

			const returnHeaders = new Headers({});
			Object.entries(combinedHeaders).forEach(([name, value]) => {
				if (value) res.headers.set(name, value);
			});
			return new Response(res.body, {
				status: res.status,
				headers: returnHeaders,
			});
		}

		const assetHandler = await handle({
			get: serveAsset,
			find: getAsset,
			applyRedirects,
			applyHeaders,
		});
		return assetHandler({
			request,
		});
	};

	return async (input, init) => {
		const request = new Request(input, init);
		return await generateResponse(request);
	};
}

const invalidAssetsFetch: typeof miniflareFetch = () => {
	throw new Error(
		"Trying to fetch assets directly when there is no `directory` option specified, and not in `local` mode."
	);
};
