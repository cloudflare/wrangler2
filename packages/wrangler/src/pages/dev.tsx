import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watch } from "chokidar";
import { unstable_dev } from "../api";
import { FatalError } from "../errors";
import { logger } from "../logger";
import * as metrics from "../metrics";
import { buildFunctions } from "./build";
import { SECONDS_TO_WAIT_FOR_PROXY } from "./constants";
import { CLEANUP, CLEANUP_CALLBACKS, pagesBetaWarning } from "./utils";
import type { ArgumentsCamelCase, Argv } from "yargs";

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
	d1?: (string | number)[];
	"live-reload": boolean;
	"local-protocol"?: "https" | "http";
	"experimental-enable-local-persistence": boolean;
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
			d1: {
				type: "array",
				description: "D1 database to bind",
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
			"local-protocol": {
				describe: "Protocol to listen to requests on, defaults to http.",
				choices: ["http", "https"] as const,
			},
			"experimental-enable-local-persistence": {
				type: "boolean",
				default: false,
				describe: "Enable persistence for this session (only for local mode)",
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
	d1: d1s = [],
	"live-reload": liveReload,
	"local-protocol": localProtocol,
	"experimental-enable-local-persistence": experimentalEnableLocalPersistence,
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

	const command = remaining;

	let proxyPort: number | undefined;

	if (directory === undefined) {
		proxyPort = await spawnProxyProcess({
			port: requestedProxyPort,
			command,
		});
		if (proxyPort === undefined) return undefined;
	} else {
		directory = resolve(directory);
	}

	let scriptReadyResolve: () => void;
	const scriptReadyPromise = new Promise<void>(
		(promiseResolve) => (scriptReadyResolve = promiseResolve)
	);

	let scriptPath: string;

	if (usingFunctions) {
		const outfile = join(tmpdir(), `./functionsWorker-${Math.random()}.js`);
		scriptPath = outfile;

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
			await metrics.sendMetricsEvent("build pages functions");
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
			await metrics.sendMetricsEvent("build pages functions");
		});
	} else {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		scriptReadyResolve!();

		scriptPath =
			directory !== undefined
				? join(directory, singleWorkerScriptPath)
				: singleWorkerScriptPath;

		if (!existsSync(scriptPath)) {
			logger.log("No functions. Shimming...");
			scriptPath = resolve(__dirname, "../templates/pages-shim.ts");
		}
	}

	await scriptReadyPromise;

	const { stop, waitUntilExit } = await unstable_dev(
		scriptPath,
		{
			port,
			watch: true,
			localProtocol,
			liveReload,

			compatibilityDate: "2021-11-02",
			nodeCompat,
			vars: Object.fromEntries(
				bindings
					.map((binding) => binding.toString().split("="))
					.map(([key, ...values]) => [key, values.join("=")])
			),
			kv: kvs.map((val) => ({
				binding: val.toString(),
				id: "",
			})),
			durableObjects: durableObjects.map((durableObject) => {
				const [name, class_name] = durableObject.toString().split("=");
				return {
					name,
					class_name,
				};
			}),
			d1: d1s.map((d1) => ({ binding: d1.toString() })),

			enablePagesAssetsServiceBinding: {
				proxyPort,
				directory,
			},
			forceLocal: true,
			experimentalEnableLocalPersistence,
			showInteractiveDevSession: undefined,
			inspect: true,
			logLevel: "error",
			logPrefix: "pages",
		},
		true
	);
	await metrics.sendMetricsEvent("run pages dev");

	waitUntilExit().then(() => {
		CLEANUP();
		stop();
		process.exit(0);
	});

	process.on("exit", () => {
		CLEANUP();
		stop();
	});
	process.on("SIGINT", () => {
		CLEANUP();
		stop();
	});
	process.on("SIGTERM", () => {
		CLEANUP();
		stop();
	});
};

function isWindows() {
	return process.platform === "win32";
}

async function sleep(ms: number) {
	await new Promise((promiseResolve) => setTimeout(promiseResolve, ms));
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
}): Promise<undefined | number> {
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
