import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout } from "node:timers/promises";
import TOML from "@iarna/toml";
import chalk from "chalk";
import onExit from "signal-exit";
import supportsColor from "supports-color";
import { setGlobalDispatcher, ProxyAgent } from "undici";
import makeCLI from "yargs";
import { version as wranglerVersion } from "../package.json";
import { fetchResult } from "./cfetch";
import { findWranglerToml, readConfig } from "./config";
import { createWorkerUploadForm } from "./create-worker-upload-form";
import { devHandler, devOptions } from "./dev";
import { confirm, prompt } from "./dialogs";
import { getEntry } from "./entry";
import { DeprecationError } from "./errors";
import { generateHandler, generateOptions } from "./generate";
import { initOptions, initHandler } from "./init";
import {
	getKVNamespaceId,
	listKVNamespaces,
	listKVNamespaceKeys,
	putKVKeyValue,
	putKVBulkKeyValue,
	deleteKVBulkKeyValue,
	createKVNamespace,
	isValidKVNamespaceBinding,
	getKVKeyValue,
	isKVKeyValue,
	unexpectedKVKeyValueProps,
	deleteKVNamespace,
	deleteKVKeyValue,
} from "./kv";
import { logger } from "./logger";
import * as metrics from "./metrics";
import { pages } from "./pages";
import {
	formatMessage,
	ParseError,
	parseJSON,
	readFileSync,
	readFileSyncToBuffer,
} from "./parse";
import { previewHandler, previewOptions } from "./preview";
import publish from "./publish";
import { pubSubCommands } from "./pubsub/pubsub-commands";
import { createR2Bucket, deleteR2Bucket, listR2Buckets } from "./r2";
import { getAssetPaths, getSiteAssetPaths } from "./sites";
import {
	createTail,
	jsonPrintLogs,
	prettyPrintLogs,
	translateCLICommandToFilterMessage,
} from "./tail";
import { updateCheck } from "./update-check";
import {
	login,
	logout,
	listScopes,
	validateScopeKeys,
	requireAuth,
} from "./user";
import { whoami } from "./whoami";

import { workerNamespaceCommands } from "./worker-namespace";
import type { Config } from "./config";
import type { KeyValue } from "./kv";
import type { TailCLIFilters } from "./tail";
import type { RawData } from "ws";
import type { CommandModule } from "yargs";
import type Yargs from "yargs";

export type ConfigPath = string | undefined;

const resetColor = "\x1b[0m";
const fgGreenColor = "\x1b[32m";
export const DEFAULT_LOCAL_PORT = 8787;
export const DEFAULT_INSPECTOR_PORT = 9229;

const proxy =
	process.env.https_proxy ||
	process.env.HTTPS_PROXY ||
	process.env.http_proxy ||
	process.env.HTTP_PROXY ||
	undefined;

if (proxy) {
	setGlobalDispatcher(new ProxyAgent(proxy));
}

export function getRules(config: Config): Config["rules"] {
	const rules = config.rules ?? config.build?.upload?.rules ?? [];

	if (config.rules && config.build?.upload?.rules) {
		throw new Error(
			`You cannot configure both [rules] and [build.upload.rules] in your wrangler.toml. Delete the \`build.upload\` section.`
		);
	}

	if (config.build?.upload?.rules) {
		logger.warn(
			`Deprecation: The \`build.upload.rules\` config field is no longer used, the rules should be specified via the \`rules\` config field. Delete the \`build.upload\` field from the configuration file, and add this:

${TOML.stringify({ rules: config.build.upload.rules })}`
		);
	}
	return rules;
}

export async function printWranglerBanner() {
	// Let's not print this in tests
	if (typeof jest !== "undefined") {
		return;
	}

	const text = ` ⛅️ wrangler ${wranglerVersion} ${await updateCheck()}`;

	logger.log(
		text +
			"\n" +
			(supportsColor.stdout
				? chalk.hex("#FF8800")("-".repeat(text.length))
				: "-".repeat(text.length))
	);
}

export function isLegacyEnv(config: Config): boolean {
	// We only read from config here, because we've already accounted for
	// args["legacy-env"] in https://github.com/cloudflare/wrangler2/blob/b24aeb5722370c2e04bce97a84a1fa1e55725d79/packages/wrangler/src/config/validation.ts#L94-L98
	return config.legacy_env;
}

export function getScriptName(
	args: { name: string | undefined; env: string | undefined },
	config: Config
): string | undefined {
	if (args.name && isLegacyEnv(config) && args.env) {
		throw new CommandLineArgsError(
			"In legacy environment mode you cannot use --name and --env together. If you want to specify a Worker name for a specific environment you can add the following to your wrangler.toml config:" +
				`
    [env.${args.env}]
    name = "${args.name}"
    `
		);
	}

	return args.name ?? config.name;
}

/**
 * Alternative to the getScriptName() because special Legacy cases allowed "name", and "env" together in Wrangler1
 */
function getLegacyScriptName(
	args: { name: string | undefined; env: string | undefined },
	config: Config
) {
	return args.name && args.env && isLegacyEnv(config)
		? `${args.name}-${args.env}`
		: args.name ?? config.name;
}

/**
 * Get a promise to the streamed input from stdin.
 *
 * This function can be used to grab the incoming stream of data from, say,
 * piping the output of another process into the wrangler process.
 */
function readFromStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		const chunks: string[] = [];

		// When there is data ready to be read, the `readable` event will be triggered.
		// In the handler for `readable` we call `read()` over and over until all the available data has been read.
		stdin.on("readable", () => {
			let chunk;
			while (null !== (chunk = stdin.read())) {
				chunks.push(chunk);
			}
		});

		// When the streamed data is complete the `end` event will be triggered.
		// In the handler for `end` we join the chunks together and resolve the promise.
		stdin.on("end", () => {
			resolve(chunks.join(""));
		});

		// If there is an `error` event then the handler will reject the promise.
		stdin.on("error", (err) => {
			reject(err);
		});
	});
}

// a helper to demand one of a set of options
// via https://github.com/yargs/yargs/issues/1093#issuecomment-491299261
function demandOneOfOption(...options: string[]) {
	return function (argv: Yargs.Arguments) {
		const count = options.filter((option) => argv[option]).length;
		const lastOption = options.pop();

		if (count === 0) {
			throw new CommandLineArgsError(
				`Exactly one of the arguments ${options.join(
					", "
				)} and ${lastOption} is required`
			);
		} else if (count > 1) {
			throw new CommandLineArgsError(
				`Arguments ${options.join(
					", "
				)} and ${lastOption} are mutually exclusive`
			);
		}

		return true;
	};
}

/**
 * Remove trailing white space from inputs.
 * Matching Wrangler legacy behavior with handling inputs
 */
function trimTrailingWhitespace(str: string) {
	return str.trimEnd();
}

export class CommandLineArgsError extends Error {}

function createCLIParser(argv: string[]) {
	const wrangler = makeCLI(argv)
		.strict()
		// We handle errors ourselves in a try-catch around `yargs.parse`.
		// If you want the "help info" to be displayed then throw an instance of `CommandLineArgsError`.
		// Otherwise we just log the error that was thrown without any "help info".
		.showHelpOnFail(false)
		.fail((msg, error) => {
			if (!error || error.name === "YError") {
				// If there is no error or the error is a "YError", then this came from yargs own validation
				// Wrap it in a `CommandLineArgsError` so that we can handle it appropriately further up.
				error = new CommandLineArgsError(msg);
			}
			throw error;
		})
		.scriptName("wrangler")
		.wrap(null);

	// Default help command that supports the subcommands
	const subHelp: CommandModule = {
		command: ["*"],
		handler: async (args) => {
			setImmediate(() =>
				wrangler.parse([...args._.map((a) => `${a}`), "--help"])
			);
		},
	};
	wrangler.command(
		["*"],
		false,
		() => {},
		async (args) => {
			if (args._.length > 0) {
				throw new CommandLineArgsError(`Unknown command: ${args._}.`);
			} else {
				// args.v will exist and be true in the case that no command is called, and the -v
				// option is present. This is to allow for running asynchronous printWranglerBanner
				// in the version command.
				if (args.v) {
					if (process.stdout.isTTY) {
						await printWranglerBanner();
					} else {
						logger.log(wranglerVersion);
					}
				} else {
					wrangler.showHelp("log");
				}
			}
		}
	);

	// You will note that we use the form for all commands where we use the builder function
	// to define options and subcommands.
	// Further we return the result of this builder even though it's not completely necessary.
	// The reason is that it's required for type inference of the args in the handle function.
	// I wish we could enforce this pattern, but this comment will have to do for now.
	// (It's also annoying that choices[] doesn't get inferred as an enum. 🤷‍♂.)

	// [DEPRECATED] generate
	wrangler.command(
		// we definitely want to move away from us cloning github templates
		// we can do something better here, let's see
		"generate [name] [template]",
		false,
		generateOptions,
		generateHandler
	);

	// init
	wrangler.command(
		"init [name]",
		"📥 Create a wrangler.toml configuration file",
		initOptions,
		initHandler
	);

	// build
	wrangler.command(
		"build",
		false,
		(yargs) => {
			return yargs.option("env", {
				describe: "Perform on a specific environment",
				type: "string",
			});
		},
		async (buildArgs) => {
			// "[DEPRECATED] 🦀 Build your project (if applicable)",

			const envFlag = buildArgs.env ? ` --env=${buildArgs.env}` : "";
			logger.log(
				formatMessage({
					kind: "warning",
					text: "Deprecation: `wrangler build` has been deprecated.",
					notes: [
						{
							text: "Please refer to https://developers.cloudflare.com/workers/wrangler/migration/deprecations/#build for more information.",
						},
						{
							text: `Attempting to run \`wrangler publish --dry-run --outdir=dist${envFlag}\` for you instead:`,
						},
					],
				})
			);

			await createCLIParser([
				"publish",
				"--dry-run",
				"--outdir=dist",
				...(buildArgs.env ? ["--env", buildArgs.env] : []),
			]).parse();
		}
	);

	// config
	wrangler.command(
		"config",
		false,
		() => {},
		() => {
			// "🕵️  Authenticate Wrangler with a Cloudflare API Token",
			throw new DeprecationError(
				"`wrangler config` has been deprecated, please refer to https://developers.cloudflare.com/workers/wrangler/migration/deprecations/#config for alternatives"
			);
		}
	);

	// dev
	wrangler.command(
		"dev [script]",
		"👂 Start a local server for developing your worker",
		devOptions,
		devHandler
	);

	// publish
	wrangler.command(
		"publish [script]",
		"🆙 Publish your Worker to Cloudflare.",
		(yargs) => {
			return (
				yargs
					.option("env", {
						type: "string",
						requiresArg: true,
						describe: "Perform on a specific environment",
						alias: "e",
					})
					.positional("script", {
						describe: "The path to an entry point for your worker",
						type: "string",
						requiresArg: true,
					})
					.option("name", {
						describe: "Name of the worker",
						type: "string",
						requiresArg: true,
					})
					// We want to have a --no-bundle flag, but yargs requires that
					// we also have a --bundle flag (that it adds the --no to by itself)
					// So we make a --bundle flag, but hide it, and then add a --no-bundle flag
					// that's visible to the user but doesn't "do" anything.
					.option("bundle", {
						describe: "Run wrangler's compilation step before publishing",
						type: "boolean",
						hidden: true,
					})
					.option("no-bundle", {
						describe: "Skip internal build steps and directly publish Worker",
						type: "boolean",
						default: false,
					})
					.option("outdir", {
						describe: "Output directory for the bundled worker",
						type: "string",
						requiresArg: true,
					})
					.option("format", {
						choices: ["modules", "service-worker"] as const,
						describe: "Choose an entry type",
						deprecated: true,
					})
					.option("compatibility-date", {
						describe: "Date to use for compatibility checks",
						type: "string",
						requiresArg: true,
					})
					.option("compatibility-flags", {
						describe: "Flags to use for compatibility checks",
						alias: "compatibility-flag",
						type: "string",
						requiresArg: true,
						array: true,
					})
					.option("latest", {
						describe: "Use the latest version of the worker runtime",
						type: "boolean",
						default: false,
					})
					.option("experimental-public", {
						describe: "Static assets to be served",
						type: "string",
						requiresArg: true,
						deprecated: true,
						hidden: true,
					})
					.option("assets", {
						describe: "Static assets to be served",
						type: "string",
						requiresArg: true,
					})
					.option("site", {
						describe: "Root folder of static assets for Workers Sites",
						type: "string",
						requiresArg: true,
					})
					.option("site-include", {
						describe:
							"Array of .gitignore-style patterns that match file or directory names from the sites directory. Only matched items will be uploaded.",
						type: "string",
						requiresArg: true,
						array: true,
					})
					.option("site-exclude", {
						describe:
							"Array of .gitignore-style patterns that match file or directory names from the sites directory. Matched items will not be uploaded.",
						type: "string",
						requiresArg: true,
						array: true,
					})
					.option("triggers", {
						describe: "cron schedules to attach",
						alias: ["schedule", "schedules"],
						type: "string",
						requiresArg: true,
						array: true,
					})
					.option("routes", {
						describe: "Routes to upload",
						alias: "route",
						type: "string",
						requiresArg: true,
						array: true,
					})
					.option("jsx-factory", {
						describe: "The function that is called for each JSX element",
						type: "string",
						requiresArg: true,
					})
					.option("jsx-fragment", {
						describe: "The function that is called for each JSX fragment",
						type: "string",
						requiresArg: true,
					})
					.option("tsconfig", {
						describe: "Path to a custom tsconfig.json file",
						type: "string",
						requiresArg: true,
					})
					.option("minify", {
						describe: "Minify the Worker",
						type: "boolean",
					})
					.option("node-compat", {
						describe: "Enable node.js compatibility",
						type: "boolean",
					})
					.option("dry-run", {
						describe: "Don't actually publish",
						type: "boolean",
					})
					.option("legacy-env", {
						type: "boolean",
						describe: "Use legacy environments",
						hidden: true,
					})
			);
		},
		async (args) => {
			await printWranglerBanner();

			const configPath =
				(args.config as ConfigPath) ||
				(args.script && findWranglerToml(path.dirname(args.script)));
			const config = readConfig(configPath, args);
			await metrics.sendMetricsEvent("deploy worker script", {
				sendMetrics: config.send_metrics,
			});
			const entry = await getEntry(args, config, "publish");

			if (args.public) {
				throw new Error("The --public field has been renamed to --assets");
			}
			if (args["experimental-public"]) {
				throw new Error(
					"The --experimental-public field has been renamed to --assets"
				);
			}

			if ((args.assets || config.assets) && (args.site || config.site)) {
				throw new Error(
					"Cannot use Assets and Workers Sites in the same Worker."
				);
			}

			if (args.assets) {
				logger.warn(
					"The --assets argument is experimental and may change or break at any time"
				);
			}

			if (args.latest) {
				logger.warn(
					"Using the latest version of the Workers runtime. To silence this warning, please choose a specific version of the runtime with --compatibility-date, or add a compatibility_date to your wrangler.toml.\n"
				);
			}

			const accountId = args.dryRun ? undefined : await requireAuth(config);

			const assetPaths =
				args.assets || config.assets
					? getAssetPaths(config, args.assets)
					: getSiteAssetPaths(
							config,
							args.site,
							args.siteInclude,
							args.siteExclude
					  );

			await publish({
				config,
				accountId,
				name: getScriptName(args, config),
				rules: getRules(config),
				entry,
				env: args.env,
				compatibilityDate: args.latest
					? new Date().toISOString().substring(0, 10)
					: args["compatibility-date"],
				compatibilityFlags: args["compatibility-flags"],
				triggers: args.triggers,
				jsxFactory: args["jsx-factory"],
				jsxFragment: args["jsx-fragment"],
				tsconfig: args.tsconfig,
				routes: args.routes,
				assetPaths,
				legacyEnv: isLegacyEnv(config),
				minify: args.minify,
				nodeCompat: args.nodeCompat,
				isWorkersSite: Boolean(args.site || config.site),
				outDir: args.outdir,
				dryRun: args.dryRun,
				noBundle: !(args.bundle ?? !config.no_bundle),
			});
		}
	);

	// tail
	wrangler.command(
		"tail [name]",
		"🦚 Starts a log tailing session for a published Worker.",
		(yargs) => {
			return yargs
				.positional("name", {
					describe: "Name of the worker",
					type: "string",
				})
				.option("format", {
					default: process.stdout.isTTY ? "pretty" : "json",
					choices: ["json", "pretty"],
					describe: "The format of log entries",
				})
				.option("status", {
					choices: ["ok", "error", "canceled"],
					describe: "Filter by invocation status",
					array: true,
				})
				.option("header", {
					type: "string",
					requiresArg: true,
					describe: "Filter by HTTP header",
				})
				.option("method", {
					type: "string",
					requiresArg: true,
					describe: "Filter by HTTP method",
					array: true,
				})
				.option("sampling-rate", {
					type: "number",
					describe: "Adds a percentage of requests to log sampling rate",
				})
				.option("search", {
					type: "string",
					requiresArg: true,
					describe: "Filter by a text match in console.log messages",
				})
				.option("ip", {
					type: "string",
					requiresArg: true,
					describe:
						'Filter by the IP address the request originates from. Use "self" to filter for your own IP',
					array: true,
				})
				.option("env", {
					type: "string",
					requiresArg: true,
					describe: "Perform on a specific environment",
					alias: "e",
				})
				.option("debug", {
					type: "boolean",
					hidden: true,
					default: false,
					describe:
						"If a log would have been filtered out, send it through anyway alongside the filter which would have blocked it.",
				})
				.option("legacy-env", {
					type: "boolean",
					describe: "Use legacy environments",
					hidden: true,
				});
		},
		async (args) => {
			if (args.format === "pretty") {
				await printWranglerBanner();
			}
			const config = readConfig(args.config as ConfigPath, args);
			await metrics.sendMetricsEvent("begin log stream", {
				sendMetrics: config.send_metrics,
			});

			const scriptName = getLegacyScriptName(args, config);

			if (!scriptName) {
				throw new Error(
					"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `wrangler tail <worker-name>`"
				);
			}

			const accountId = await requireAuth(config);

			const cliFilters: TailCLIFilters = {
				status: args.status as ("ok" | "error" | "canceled")[] | undefined,
				header: args.header,
				method: args.method,
				samplingRate: args["sampling-rate"],
				search: args.search,
				clientIp: args.ip,
			};

			const filters = translateCLICommandToFilterMessage(
				cliFilters,
				args.debug
			);

			const { tail, expiration, deleteTail } = await createTail(
				accountId,
				scriptName,
				filters,
				!isLegacyEnv(config) ? args.env : undefined
			);

			const scriptDisplayName = `${scriptName}${
				args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
			}`;

			if (args.format === "pretty") {
				logger.log(
					`Successfully created tail, expires at ${expiration.toLocaleString()}`
				);
			}

			onExit(async () => {
				tail.terminate();
				await deleteTail();
				await metrics.sendMetricsEvent("end log stream", {
					sendMetrics: config.send_metrics,
				});
			});

			const printLog: (data: RawData) => void =
				args.format === "pretty" ? prettyPrintLogs : jsonPrintLogs;

			tail.on("message", printLog);

			while (tail.readyState !== tail.OPEN) {
				switch (tail.readyState) {
					case tail.CONNECTING:
						await setTimeout(100);
						break;
					case tail.CLOSING:
						await setTimeout(100);
						break;
					case tail.CLOSED:
						await metrics.sendMetricsEvent("end log stream", {
							sendMetrics: config.send_metrics,
						});
						throw new Error(
							`Connection to ${scriptDisplayName} closed unexpectedly.`
						);
				}
			}

			if (args.format === "pretty") {
				logger.log(`Connected to ${scriptDisplayName}, waiting for logs...`);
			}

			tail.on("close", async () => {
				tail.terminate();
				await deleteTail();
				await metrics.sendMetricsEvent("end log stream", {
					sendMetrics: config.send_metrics,
				});
			});
		}
	);

	// preview
	wrangler.command(
		"preview [method] [body]",
		false,
		previewOptions,
		previewHandler
	);

	// [DEPRECATED] route
	wrangler.command(
		"route",
		false, // I think we want to hide this command
		// "➡️  List or delete worker routes",
		(routeYargs) => {
			return routeYargs
				.command(
					"list",
					"List the routes associated with a zone",
					(yargs) => {
						return yargs
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
							})
							.option("zone", {
								type: "string",
								requiresArg: true,
								describe: "Zone id",
							})
							.positional("zone", {
								describe: "Zone id",
								type: "string",
							});
					},
					() => {
						// "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
						const deprecationNotice =
							"`wrangler route list` has been deprecated.";
						const futureRoutes =
							"Refer to wrangler.toml for a list of routes the worker will be deployed to upon publishing.";
						const presentRoutes =
							"Refer to the Cloudflare Dashboard to see the routes this worker is currently running on.";
						throw new DeprecationError(
							`${deprecationNotice}\n${futureRoutes}\n${presentRoutes}`
						);
					}
				)
				.command(
					"delete [id]",
					"Delete a route associated with a zone",
					(yargs) => {
						return yargs
							.positional("id", {
								describe: "The hash of the route ID to delete.",
								type: "string",
							})
							.option("zone", {
								type: "string",
								requiresArg: true,
								describe: "zone id",
							})
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
							});
					},
					() => {
						// "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
						const deprecationNotice =
							"`wrangler route delete` has been deprecated.";
						const shouldDo =
							"Remove the unwanted route(s) from wrangler.toml and run `wrangler publish` to remove your worker from those routes.";
						throw new DeprecationError(`${deprecationNotice}\n${shouldDo}`);
					}
				);
		},
		() => {
			// "👯 [DEPRECATED]. Use wrangler.toml to manage routes.
			const deprecationNotice = "`wrangler route` has been deprecated.";
			const shouldDo =
				"Please use wrangler.toml and/or `wrangler publish --routes` to modify routes";
			throw new DeprecationError(`${deprecationNotice}\n${shouldDo}`);
		}
	);

	// subdomain
	wrangler.command(
		"subdomain [name]",
		false,
		// "👷 Create or change your workers.dev subdomain.",
		(yargs) => {
			return yargs.positional("name", { type: "string" });
		},
		() => {
			throw new DeprecationError(
				"`wrangler subdomain` has been deprecated, please refer to https://developers.cloudflare.com/workers/wrangler/migration/deprecations/#subdomain for alternatives"
			);
		}
	);

	// secret
	wrangler.command(
		"secret",
		"🤫 Generate a secret that can be referenced in a Worker",
		(secretYargs) => {
			return secretYargs
				.command(subHelp)
				.option("legacy-env", {
					type: "boolean",
					describe: "Use legacy environments",
					hidden: true,
				})
				.command(
					"put <key>",
					"Create or update a secret variable for a Worker",
					(yargs) => {
						return yargs
							.positional("key", {
								describe: "The variable name to be accessible in the Worker",
								type: "string",
							})
							.option("name", {
								describe: "Name of the Worker",
								type: "string",
								requiresArg: true,
							})
							.option("env", {
								type: "string",
								requiresArg: true,
								describe:
									"Binds the secret to the Worker of the specific environment",
								alias: "e",
							});
					},
					async (args) => {
						await printWranglerBanner();
						const config = readConfig(args.config as ConfigPath, args);

						const scriptName = getLegacyScriptName(args, config);
						if (!scriptName) {
							throw new Error(
								"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
							);
						}

						const accountId = await requireAuth(config);

						const isInteractive = process.stdin.isTTY;
						const secretValue = trimTrailingWhitespace(
							isInteractive
								? await prompt("Enter a secret value:", "password")
								: await readFromStdin()
						);

						logger.log(
							`🌀 Creating the secret for the Worker "${scriptName}" ${
								args.env && !isLegacyEnv(config) ? `(${args.env})` : ""
							}`
						);

						async function submitSecret() {
							const url =
								!args.env || isLegacyEnv(config)
									? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
									: `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

							return await fetchResult(url, {
								method: "PUT",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									name: args.key,
									text: secretValue,
									type: "secret_text",
								}),
							});
						}

						const createDraftWorker = async () => {
							// TODO: log a warning
							await fetchResult(
								!isLegacyEnv(config) && args.env
									? `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}`
									: `/accounts/${accountId}/workers/scripts/${scriptName}`,
								{
									method: "PUT",
									body: createWorkerUploadForm({
										name: scriptName,
										main: {
											name: scriptName,
											content: `export default { fetch() {} }`,
											type: "esm",
										},
										bindings: {
											kv_namespaces: [],
											vars: {},
											durable_objects: { bindings: [] },
											r2_buckets: [],
											services: [],
											wasm_modules: {},
											text_blobs: {},
											data_blobs: {},
											worker_namespaces: [],
											logfwdr: { schema: "", bindings: [] },
											unsafe: [],
										},
										modules: [],
										migrations: undefined,
										compatibility_date: undefined,
										compatibility_flags: undefined,
										usage_model: undefined,
									}),
								}
							);
						};

						function isMissingWorkerError(e: unknown): e is { code: 10007 } {
							return (
								typeof e === "object" &&
								e !== null &&
								(e as { code: number }).code === 10007
							);
						}

						try {
							await submitSecret();
							await metrics.sendMetricsEvent("create encrypted variable", {
								sendMetrics: config.send_metrics,
							});
						} catch (e) {
							if (isMissingWorkerError(e)) {
								// create a draft worker and try again
								await createDraftWorker();
								await submitSecret();
								// TODO: delete the draft worker if this failed too?
							} else {
								throw e;
							}
						}

						logger.log(`✨ Success! Uploaded secret ${args.key}`);
					}
				)
				.command(
					"delete <key>",
					"Delete a secret variable from a Worker",
					async (yargs) => {
						await printWranglerBanner();
						return yargs
							.positional("key", {
								describe: "The variable name to be accessible in the Worker",
								type: "string",
							})
							.option("name", {
								describe: "Name of the Worker",
								type: "string",
								requiresArg: true,
							})
							.option("env", {
								type: "string",
								requiresArg: true,
								describe:
									"Binds the secret to the Worker of the specific environment",
								alias: "e",
							});
					},
					async (args) => {
						const config = readConfig(args.config as ConfigPath, args);

						const scriptName = getLegacyScriptName(args, config);
						if (!scriptName) {
							throw new Error(
								"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
							);
						}

						const accountId = await requireAuth(config);

						if (
							await confirm(
								`Are you sure you want to permanently delete the secret ${
									args.key
								} on the Worker ${scriptName}${
									args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
								}?`
							)
						) {
							logger.log(
								`🌀 Deleting the secret ${
									args.key
								} on the Worker ${scriptName}${
									args.env && !isLegacyEnv(config) ? ` (${args.env})` : ""
								}`
							);

							const url =
								!args.env || isLegacyEnv(config)
									? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
									: `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

							await fetchResult(`${url}/${args.key}`, { method: "DELETE" });
							await metrics.sendMetricsEvent("delete encrypted variable", {
								sendMetrics: config.send_metrics,
							});
							logger.log(`✨ Success! Deleted secret ${args.key}`);
						}
					}
				)
				.command(
					"list",
					"List all secrets for a Worker",
					(yargs) => {
						return yargs
							.option("name", {
								describe: "Name of the Worker",
								type: "string",
								requiresArg: true,
							})
							.option("env", {
								type: "string",
								requiresArg: true,
								describe:
									"Binds the secret to the Worker of the specific environment.",
								alias: "e",
							});
					},
					async (args) => {
						const config = readConfig(args.config as ConfigPath, args);

						const scriptName = getLegacyScriptName(args, config);
						if (!scriptName) {
							throw new Error(
								"Required Worker name missing. Please specify the Worker name in wrangler.toml, or pass it as an argument with `--name <worker-name>`"
							);
						}

						const accountId = await requireAuth(config);

						const url =
							!args.env || isLegacyEnv(config)
								? `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`
								: `/accounts/${accountId}/workers/services/${scriptName}/environments/${args.env}/secrets`;

						logger.log(JSON.stringify(await fetchResult(url), null, "  "));
						await metrics.sendMetricsEvent("list encrypted variables", {
							sendMetrics: config.send_metrics,
						});
					}
				);
		}
	);

	// kv
	// :namespace
	wrangler.command(
		"kv:namespace",
		"🗂️  Interact with your Workers KV Namespaces",
		(namespaceYargs) => {
			return namespaceYargs
				.command(subHelp)
				.command(
					"create <namespace>",
					"Create a new namespace",
					(yargs) => {
						return yargs
							.positional("namespace", {
								describe: "The name of the new namespace",
								type: "string",
								demandOption: true,
							})
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							});
					},
					async (args) => {
						await printWranglerBanner();

						if (!isValidKVNamespaceBinding(args.namespace)) {
							throw new CommandLineArgsError(
								`The namespace binding name "${args.namespace}" is invalid. It can only have alphanumeric and _ characters, and cannot begin with a number.`
							);
						}

						const config = readConfig(args.config as ConfigPath, args);
						if (!config.name) {
							logger.warn(
								"No configured name present, using `worker` as a prefix for the title"
							);
						}

						const name = config.name || "worker";
						const environment = args.env ? `-${args.env}` : "";
						const preview = args.preview ? "_preview" : "";
						const title = `${name}${environment}-${args.namespace}${preview}`;

						const accountId = await requireAuth(config);

						// TODO: generate a binding name stripping non alphanumeric chars

						logger.log(`🌀 Creating namespace with title "${title}"`);
						const namespaceId = await createKVNamespace(accountId, title);
						await metrics.sendMetricsEvent("create kv namespace", {
							sendMetrics: config.send_metrics,
						});

						logger.log("✨ Success!");
						const envString = args.env ? ` under [env.${args.env}]` : "";
						const previewString = args.preview ? "preview_" : "";
						logger.log(
							`Add the following to your configuration file in your kv_namespaces array${envString}:`
						);
						logger.log(
							`{ binding = "${args.namespace}", ${previewString}id = "${namespaceId}" }`
						);

						// TODO: automatically write this block to the wrangler.toml config file??
					}
				)
				.command(
					"list",
					"Outputs a list of all KV namespaces associated with your account id.",
					{},
					async (args) => {
						const config = readConfig(args.config as ConfigPath, args);

						const accountId = await requireAuth(config);

						// TODO: we should show bindings if they exist for given ids

						logger.log(
							JSON.stringify(await listKVNamespaces(accountId), null, "  ")
						);
						await metrics.sendMetricsEvent("list kv namespaces", {
							sendMetrics: config.send_metrics,
						});
					}
				)
				.command(
					"delete",
					"Deletes a given namespace.",
					(yargs) => {
						return yargs
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to delete",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to delete",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							});
					},
					async (args) => {
						await printWranglerBanner();
						const config = readConfig(args.config as ConfigPath, args);

						let id;
						try {
							id = getKVNamespaceId(args, config);
						} catch (e) {
							throw new CommandLineArgsError(
								"Not able to delete namespace.\n" + ((e as Error).message ?? e)
							);
						}

						const accountId = await requireAuth(config);

						logger.log(`Deleting KV namespace ${id}.`);
						await deleteKVNamespace(accountId, id);
						logger.log(`Deleted KV namespace ${id}.`);
						await metrics.sendMetricsEvent("delete kv namespace", {
							sendMetrics: config.send_metrics,
						});

						// TODO: recommend they remove it from wrangler.toml

						// test-mf wrangler kv:namespace delete --namespace-id 2a7d3d8b23fc4159b5afa489d6cfd388
						// Are you sure you want to delete namespace 2a7d3d8b23fc4159b5afa489d6cfd388? [y/n]
						// n
						// 💁  Not deleting namespace 2a7d3d8b23fc4159b5afa489d6cfd388
						// ➜  test-mf wrangler kv:namespace delete --namespace-id 2a7d3d8b23fc4159b5afa489d6cfd388
						// Are you sure you want to delete namespace 2a7d3d8b23fc4159b5afa489d6cfd388? [y/n]
						// y
						// 🌀  Deleting namespace 2a7d3d8b23fc4159b5afa489d6cfd388
						// ✨  Success
						// ⚠️  Make sure to remove this "kv-namespace" entry from your configuration file!
						// ➜  test-mf

						// TODO: do it automatically

						// TODO: delete the preview namespace as well?
					}
				);
		}
	);

	// :key
	wrangler.command(
		"kv:key",
		"🔑 Individually manage Workers KV key-value pairs",
		(kvKeyYargs) => {
			return kvKeyYargs
				.command(subHelp)
				.command(
					"put <key> [value]",
					"Writes a single key/value pair to the given namespace.",
					(yargs) => {
						return yargs
							.positional("key", {
								type: "string",
								describe: "The key to write to",
								demandOption: true,
							})
							.positional("value", {
								type: "string",
								describe: "The value to write",
							})
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The binding of the namespace to write to",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to write to",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							})
							.option("ttl", {
								type: "number",
								describe: "Time for which the entries should be visible",
							})
							.option("expiration", {
								type: "number",
								describe:
									"Time since the UNIX epoch after which the entry expires",
							})
							.option("metadata", {
								type: "string",
								describe: "Arbitrary JSON that is associated with a key",
								coerce: (jsonStr: string): KeyValue["metadata"] => {
									try {
										return JSON.parse(jsonStr);
									} catch (_) {}
								},
							})
							.option("path", {
								type: "string",
								requiresArg: true,
								describe: "Read value from the file at a given path",
							})
							.check(demandOneOfOption("value", "path"));
					},
					async ({ key, ttl, expiration, metadata, ...args }) => {
						await printWranglerBanner();
						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);
						// One of `args.path` and `args.value` must be defined
						const value = args.path
							? readFileSyncToBuffer(args.path)
							: // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
							  args.value!;

						const metadataLog = metadata
							? ` with metadata "${JSON.stringify(metadata)}"`
							: "";

						if (args.path) {
							logger.log(
								`Writing the contents of ${args.path} to the key "${key}" on namespace ${namespaceId}${metadataLog}.`
							);
						} else {
							logger.log(
								`Writing the value "${value}" to key "${key}" on namespace ${namespaceId}${metadataLog}.`
							);
						}

						const accountId = await requireAuth(config);

						await putKVKeyValue(accountId, namespaceId, {
							key,
							value,
							expiration,
							expiration_ttl: ttl,
							metadata: metadata as KeyValue["metadata"],
						});
						await metrics.sendMetricsEvent("write kv key-value", {
							sendMetrics: config.send_metrics,
						});
					}
				)
				.command(
					"list",
					"Outputs a list of all keys in a given namespace.",
					(yargs) => {
						return yargs
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to list",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to list",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								// In the case of listing keys we will default to non-preview mode
								default: false,
								describe: "Interact with a preview namespace",
							})
							.option("prefix", {
								type: "string",
								requiresArg: true,
								describe: "A prefix to filter listed keys",
							});
					},
					async ({ prefix, ...args }) => {
						// TODO: support for limit+cursor (pagination)
						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);

						const accountId = await requireAuth(config);

						const results = await listKVNamespaceKeys(
							accountId,
							namespaceId,
							prefix
						);
						logger.log(JSON.stringify(results, undefined, 2));
						await metrics.sendMetricsEvent("list kv keys", {
							sendMetrics: config.send_metrics,
						});
					}
				)
				.command(
					"get <key>",
					"Reads a single value by key from the given namespace.",
					(yargs) => {
						return yargs
							.positional("key", {
								describe: "The key value to get.",
								type: "string",
								demandOption: true,
							})
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to get from",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to get from",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							})
							.option("preview", {
								type: "boolean",
								// In the case of getting key values we will default to non-preview mode
								default: false,
								describe: "Interact with a preview namespace",
							})
							.option("text", {
								type: "boolean",
								default: false,
								describe: "Decode the returned value as a utf8 string",
							});
					},
					async ({ key, ...args }) => {
						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);

						const accountId = await requireAuth(config);
						const bufferKVValue = Buffer.from(
							await getKVKeyValue(accountId, namespaceId, key)
						);

						if (args.text) {
							const decoder = new StringDecoder("utf8");
							logger.log(decoder.write(bufferKVValue));
						} else {
							process.stdout.write(bufferKVValue);
						}
						await metrics.sendMetricsEvent("read kv value", {
							sendMetrics: config.send_metrics,
						});
					}
				)
				.command(
					"delete <key>",
					"Removes a single key value pair from the given namespace.",
					(yargs) => {
						return yargs
							.positional("key", {
								describe: "The key value to delete",
								type: "string",
								demandOption: true,
							})
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to delete from",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to delete from",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							});
					},
					async ({ key, ...args }) => {
						await printWranglerBanner();
						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);

						logger.log(
							`Deleting the key "${key}" on namespace ${namespaceId}.`
						);

						const accountId = await requireAuth(config);

						await deleteKVKeyValue(accountId, namespaceId, key);
						await metrics.sendMetricsEvent("delete kv key-value", {
							sendMetrics: config.send_metrics,
						});
					}
				);
		}
	);

	// :bulk
	wrangler.command(
		"kv:bulk",
		"💪 Interact with multiple Workers KV key-value pairs at once",
		(kvBulkYargs) => {
			return kvBulkYargs
				.command(subHelp)
				.command(
					"put <filename>",
					"Upload multiple key-value pairs to a namespace",
					(yargs) => {
						return yargs
							.positional("filename", {
								describe: `The JSON file of key-value pairs to upload, in form [{"key":..., "value":...}"...]`,
								type: "string",
								demandOption: true,
							})
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to insert values into",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to insert values into",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							});
					},
					async ({ filename, ...args }) => {
						await printWranglerBanner();
						// The simplest implementation I could think of.
						// This could be made more efficient with a streaming parser/uploader
						// but we'll do that in the future if needed.

						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);
						const content = parseJSON(readFileSync(filename), filename);

						if (!Array.isArray(content)) {
							throw new Error(
								`Unexpected JSON input from "${filename}".\n` +
									`Expected an array of key-value objects but got type "${typeof content}".`
							);
						}

						const errors: string[] = [];
						const warnings: string[] = [];
						for (let i = 0; i < content.length; i++) {
							const keyValue = content[i];
							if (!isKVKeyValue(keyValue)) {
								errors.push(
									`The item at index ${i} is ${JSON.stringify(keyValue)}`
								);
							} else {
								const props = unexpectedKVKeyValueProps(keyValue);
								if (props.length > 0) {
									warnings.push(
										`The item at index ${i} contains unexpected properties: ${JSON.stringify(
											props
										)}.`
									);
								}
							}
						}
						if (warnings.length > 0) {
							logger.warn(
								`Unexpected key-value properties in "${filename}".\n` +
									warnings.join("\n")
							);
						}
						if (errors.length > 0) {
							throw new Error(
								`Unexpected JSON input from "${filename}".\n` +
									`Each item in the array should be an object that matches:\n\n` +
									`interface KeyValue {\n` +
									`  key: string;\n` +
									`  value: string;\n` +
									`  expiration?: number;\n` +
									`  expiration_ttl?: number;\n` +
									`  metadata?: object;\n` +
									`  base64?: boolean;\n` +
									`}\n\n` +
									errors.join("\n")
							);
						}

						const accountId = await requireAuth(config);
						await putKVBulkKeyValue(accountId, namespaceId, content);
						await metrics.sendMetricsEvent("write kv key-values (bulk)", {
							sendMetrics: config.send_metrics,
						});

						logger.log("Success!");
					}
				)
				.command(
					"delete <filename>",
					"Delete multiple key-value pairs from a namespace",
					(yargs) => {
						return yargs
							.positional("filename", {
								describe: `The JSON file of keys to delete, in the form ["key1", "key2", ...]`,
								type: "string",
								demandOption: true,
							})
							.option("binding", {
								type: "string",
								requiresArg: true,
								describe: "The name of the namespace to delete from",
							})
							.option("namespace-id", {
								type: "string",
								requiresArg: true,
								describe: "The id of the namespace to delete from",
							})
							.check(demandOneOfOption("binding", "namespace-id"))
							.option("env", {
								type: "string",
								requiresArg: true,
								describe: "Perform on a specific environment",
								alias: "e",
							})
							.option("preview", {
								type: "boolean",
								describe: "Interact with a preview namespace",
							})
							.option("force", {
								type: "boolean",
								alias: "f",
								describe: "Do not ask for confirmation before deleting",
							});
					},
					async ({ filename, ...args }) => {
						await printWranglerBanner();
						const config = readConfig(args.config as ConfigPath, args);
						const namespaceId = getKVNamespaceId(args, config);

						if (!args.force) {
							const result = await confirm(
								`Are you sure you want to delete all the keys read from "${filename}" from kv-namespace with id "${namespaceId}"?`
							);
							if (!result) {
								logger.log(`Not deleting keys read from "${filename}".`);
								return;
							}
						}

						const content = parseJSON(
							readFileSync(filename),
							filename
						) as string[];

						if (!Array.isArray(content)) {
							throw new Error(
								`Unexpected JSON input from "${filename}".\n` +
									`Expected an array of strings but got:\n${content}`
							);
						}

						const errors: string[] = [];
						for (let i = 0; i < content.length; i++) {
							const key = content[i];
							if (typeof key !== "string") {
								errors.push(
									`The item at index ${i} is type: "${typeof key}" - ${JSON.stringify(
										key
									)}`
								);
							}
						}
						if (errors.length > 0) {
							throw new Error(
								`Unexpected JSON input from "${filename}".\n` +
									`Expected an array of strings.\n` +
									errors.join("\n")
							);
						}

						const accountId = await requireAuth(config);

						await deleteKVBulkKeyValue(accountId, namespaceId, content);
						await metrics.sendMetricsEvent("delete kv key-values (bulk)", {
							sendMetrics: config.send_metrics,
						});

						logger.log("Success!");
					}
				);
		}
	);

	wrangler.command(
		"pages",
		"⚡️ Configure Cloudflare Pages",
		async (pagesYargs) => {
			await pages(pagesYargs.command(subHelp));
		}
	);

	wrangler.command("r2", "📦 Interact with an R2 store", (r2Yargs) => {
		return r2Yargs
			.command(subHelp)
			.command("bucket", "Manage R2 buckets", (r2BucketYargs) => {
				r2BucketYargs.command(
					"create <name>",
					"Create a new R2 bucket",
					(yargs) => {
						return yargs.positional("name", {
							describe: "The name of the new bucket",
							type: "string",
							demandOption: true,
						});
					},
					async (args) => {
						await printWranglerBanner();

						const config = readConfig(args.config as ConfigPath, args);

						const accountId = await requireAuth(config);

						logger.log(`Creating bucket ${args.name}.`);
						await createR2Bucket(accountId, args.name);
						logger.log(`Created bucket ${args.name}.`);
						await metrics.sendMetricsEvent("create r2 bucket", {
							sendMetrics: config.send_metrics,
						});
					}
				);

				r2BucketYargs.command("list", "List R2 buckets", {}, async (args) => {
					const config = readConfig(args.config as ConfigPath, args);

					const accountId = await requireAuth(config);

					logger.log(JSON.stringify(await listR2Buckets(accountId), null, 2));
					await metrics.sendMetricsEvent("list r2 buckets", {
						sendMetrics: config.send_metrics,
					});
				});

				r2BucketYargs.command(
					"delete <name>",
					"Delete an R2 bucket",
					(yargs) => {
						return yargs.positional("name", {
							describe: "The name of the bucket to delete",
							type: "string",
							demandOption: true,
						});
					},
					async (args) => {
						await printWranglerBanner();

						const config = readConfig(args.config as ConfigPath, args);

						const accountId = await requireAuth(config);

						logger.log(`Deleting bucket ${args.name}.`);
						await deleteR2Bucket(accountId, args.name);
						logger.log(`Deleted bucket ${args.name}.`);
						await metrics.sendMetricsEvent("delete r2 bucket", {
							sendMetrics: config.send_metrics,
						});
					}
				);
				return r2BucketYargs;
			});
	});

	wrangler.command(
		"worker-namespace",
		"📦 Interact with a worker namespace",
		(workerNamespaceYargs) => {
			return workerNamespaceCommands(workerNamespaceYargs, subHelp);
		}
	);

	wrangler.command(
		"pubsub",
		"📮 Interact and manage Pub/Sub Brokers",
		(pubsubYargs) => {
			return pubSubCommands(pubsubYargs, subHelp);
		}
	);

	/**
	 * User Group: login, logout, and whoami
	 * TODO: group commands into User group similar to .group() for flags in yargs
	 */
	// login
	wrangler.command(
		// this needs scopes as an option?
		"login",
		"🔓 Login to Cloudflare",
		(yargs) => {
			// TODO: This needs some copy editing
			// I mean, this entire app does, but this too.
			return yargs
				.option("scopes-list", {
					describe: "List all the available OAuth scopes with descriptions",
				})
				.option("scopes", {
					describe: "Pick the set of applicable OAuth scopes when logging in",
					array: true,
					type: "string",
					requiresArg: true,
				});

			// TODO: scopes
		},
		async (args) => {
			await printWranglerBanner();
			if (args["scopes-list"]) {
				listScopes();
				return;
			}
			if (args.scopes) {
				if (args.scopes.length === 0) {
					// don't allow no scopes to be passed, that would be weird
					listScopes();
					return;
				}
				if (!validateScopeKeys(args.scopes)) {
					throw new CommandLineArgsError(
						`One of ${args.scopes} is not a valid authentication scope. Run "wrangler login --list-scopes" to see the valid scopes.`
					);
				}
				await login({ scopes: args.scopes });
				return;
			}
			await login();
			const config = readConfig(args.config as ConfigPath, args);
			await metrics.sendMetricsEvent("login user", {
				sendMetrics: config.send_metrics,
			});

			// TODO: would be nice if it optionally saved login
			// credentials inside node_modules/.cache or something
			// this way you could have multiple users on a single machine
		}
	);

	// logout
	wrangler.command(
		// this needs scopes as an option?
		"logout",
		"🚪 Logout from Cloudflare",
		() => {},
		async () => {
			await printWranglerBanner();
			await logout();
			const config = readConfig(undefined, {});
			await metrics.sendMetricsEvent("logout user", {
				sendMetrics: config.send_metrics,
			});
		}
	);

	// whoami
	wrangler.command(
		"whoami",
		"🕵️  Retrieve your user info and test your auth config",
		() => {},
		async () => {
			await printWranglerBanner();
			await whoami();
			const config = readConfig(undefined, {});
			await metrics.sendMetricsEvent("view accounts", {
				sendMetrics: config.send_metrics,
			});
		}
	);

	// This set to false to allow overwrite of default behaviour
	wrangler.version(false);

	// version
	wrangler.command(
		"version",
		false,
		() => {},
		async () => {
			if (process.stdout.isTTY) {
				await printWranglerBanner();
			} else {
				logger.log(wranglerVersion);
			}
		}
	);

	wrangler.option("v", {
		describe: "Show version number",
		alias: "version",
		type: "boolean",
	});

	wrangler.option("config", {
		alias: "c",
		describe: "Path to .toml configuration file",
		type: "string",
		requiresArg: true,
	});

	wrangler.group(["config", "help", "version"], "Flags:");
	wrangler.help().alias("h", "help");

	wrangler.exitProcess(false);

	return wrangler;
}

export async function main(argv: string[]): Promise<void> {
	const wrangler = createCLIParser(argv);
	try {
		await wrangler.parse();
	} catch (e) {
		logger.log(""); // Just adds a bit of space
		if (e instanceof CommandLineArgsError) {
			logger.error(e.message);
			// We are not able to ask the `wrangler` CLI parser to show help for a subcommand programmatically.
			// The workaround is to re-run the parsing with an additional `--help` flag, which will result in the correct help message being displayed.
			// The `wrangler` object is "frozen"; we cannot reuse that with different args, so we must create a new CLI parser to generate the help message.
			await createCLIParser([...argv, "--help"]).parse();
		} else if (e instanceof ParseError) {
			e.notes.push({
				text: "\nIf you think this is a bug, please open an issue at: https://github.com/cloudflare/wrangler2/issues/new/choose",
			});
			logger.log(formatMessage(e));
		} else {
			logger.error(e instanceof Error ? e.message : e);
			logger.log(
				`${fgGreenColor}%s${resetColor}`,
				"If you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new/choose"
			);
		}
		throw e;
	}
}

export function getDevCompatibilityDate(
	config: Config,
	compatibilityDate = config.compatibility_date
) {
	const currentDate = new Date().toISOString().substring(0, 10);
	if (config.configPath !== undefined && compatibilityDate === undefined) {
		logger.warn(
			`No compatibility_date was specified. Using today's date: ${currentDate}.\n` +
				"Add one to your wrangler.toml file:\n" +
				"```\n" +
				`compatibility_date = "${currentDate}"\n` +
				"```\n" +
				"or pass it in your terminal:\n" +
				"```\n" +
				`--compatibility-date=${currentDate}\n` +
				"```\n" +
				"See https://developers.cloudflare.com/workers/platform/compatibility-dates for more information."
		);
	}
	return compatibilityDate ?? currentDate;
}
