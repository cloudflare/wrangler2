import { spawn } from "node:child_process";
import * as path from "node:path";
import * as util from "node:util";
import { watch } from "chokidar";
import clipboardy from "clipboardy";
import commandExists from "command-exists";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import React, { useState, useEffect, useRef } from "react";
import { withErrorBoundary, useErrorHandler } from "react-error-boundary";
import onExit from "signal-exit";
import tmp from "tmp-promise";
import { fetch } from "undici";
import {
	getRegisteredWorkers,
	startWorkerRegistry,
	stopWorkerRegistry,
	unregisterWorker,
} from "../dev-registry";
import { runCustomBuild } from "../entry";
import { openInspector } from "../inspect";
import { logger } from "../logger";
import openInBrowser from "../open-in-browser";
import { Local } from "./local";
import { Remote } from "./remote";
import { useEsbuild } from "./use-esbuild";
import type { Config } from "../config";
import type { Route } from "../config/environment";
import type { WorkerRegistry } from "../dev-registry";
import type { Entry } from "../entry";
import type { EnablePagesAssetsServiceBindingOptions } from "../miniflare-cli";
import type { AssetPaths } from "../sites";
import type { CfWorkerInit } from "../worker";

/**
 * This hooks establishes a connection with the dev registry,
 * and periodically updates itself with details of workers currently
 * running a dev session on this system.
 */
function useDevRegistry(
	name: string | undefined,
	services: Config["services"] | undefined,
	mode: "local" | "remote"
): WorkerRegistry {
	const [workers, setWorkers] = useState<WorkerRegistry>({});

	useEffect(() => {
		// Let's try to start registry
		// TODO: we should probably call this in a loop
		// in case the registry dies elsewhere
		startWorkerRegistry().catch((err) => {
			logger.error("failed to start worker registry", err);
		});

		const serviceNames = (services || []).map(
			(serviceBinding) => serviceBinding.service
		);

		const interval =
			// TODO: enable this for remote mode as well
			// https://github.com/cloudflare/wrangler2/issues/1182
			mode === "local"
				? setInterval(() => {
						getRegisteredWorkers().then(
							(workerDefinitions: WorkerRegistry | undefined) => {
								// We only want the workers that we're bound to
								// so let's filter out the others
								const filteredWorkers = Object.fromEntries(
									Object.entries(workerDefinitions || {}).filter(
										([key, _value]) => serviceNames.includes(key)
									)
								);
								setWorkers((prevWorkers) => {
									if (!util.isDeepStrictEqual(filteredWorkers, prevWorkers)) {
										return filteredWorkers;
									}
									return prevWorkers;
								});
							},
							(err) => {
								logger.warn("Failed to get worker definitions", err);
							}
						);
				  }, 300)
				: undefined;

		return () => {
			interval && clearInterval(interval);
			Promise.allSettled([
				name ? unregisterWorker(name) : Promise.resolve(),
				stopWorkerRegistry(),
			]).then(
				([unregisterResult, stopRegistryResult]) => {
					if (unregisterResult.status === "rejected") {
						logger.error(
							"Failed to unregister worker",
							unregisterResult.reason
						);
					}
					if (stopRegistryResult.status === "rejected") {
						logger.error(
							"Failed to stop worker registry",
							stopRegistryResult.reason
						);
					}
				},
				(err) => {
					logger.error("Failed to clear dev registry effect", err);
				}
			);
		};
	}, [name, services, mode]);

	return workers;
}

export type DevProps = {
	name: string | undefined;
	noBundle: boolean;
	entry: Entry;
	port: number;
	ip: string;
	inspectorPort: number;
	rules: Config["rules"];
	accountId: string | undefined;
	initialMode: "local" | "remote";
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	tsconfig: string | undefined;
	upstreamProtocol: "https" | "http";
	localProtocol: "https" | "http";
	localUpstream: string | undefined;
	enableLocalPersistence: boolean;
	liveReload: boolean;
	bindings: CfWorkerInit["bindings"];
	define: Config["define"];
	crons: Config["triggers"]["crons"];
	isWorkersSite: boolean;
	assetPaths: AssetPaths | undefined;
	compatibilityDate: string;
	compatibilityFlags: string[] | undefined;
	usageModel: "bundled" | "unbound" | undefined;
	minify: boolean | undefined;
	nodeCompat: boolean | undefined;
	build: Config["build"];
	env: string | undefined;
	legacyEnv: boolean;
	zone: string | undefined;
	host: string | undefined;
	routes: Route[] | undefined;
	inspect: boolean;
	logLevel: "none" | "error" | "log" | "warn" | "debug" | undefined;
	logPrefix?: string;
	onReady: (() => void) | undefined;
	showInteractiveDevSession: boolean | undefined;
	forceLocal: boolean | undefined;
	enablePagesAssetsServiceBinding?: EnablePagesAssetsServiceBindingOptions;
};

export function DevImplementation(props: DevProps): JSX.Element {
	if (
		!props.isWorkersSite &&
		props.assetPaths &&
		props.entry.format === "service-worker"
	) {
		throw new Error(
			"You cannot use the service-worker format with an `assets` directory yet. For information on how to migrate to the module-worker format, see: https://developers.cloudflare.com/workers/learning/migrating-to-module-workers/"
		);
	}

	if (props.bindings.wasm_modules && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [wasm_modules] with an ES module worker. Instead, import the .wasm module directly in your code"
		);
	}

	if (props.bindings.text_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [text_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}

	if (props.bindings.data_blobs && props.entry.format === "modules") {
		throw new Error(
			"You cannot configure [data_blobs] with an ES module worker. Instead, import the file directly in your code, and optionally configure `[rules]` in your wrangler.toml"
		);
	}

	// only load the UI if we're running in a supported environment
	const { isRawModeSupported } = useStdin();

	return props.showInteractiveDevSession ?? isRawModeSupported ? (
		<InteractiveDevSession {...props} />
	) : (
		<DevSession {...props} local={props.initialMode === "local"} />
	);
}

function InteractiveDevSession(props: DevProps) {
	const toggles = useHotkeys({
		initial: {
			local: props.initialMode === "local",
			tunnel: false,
		},
		port: props.port,
		ip: props.ip,
		inspectorPort: props.inspectorPort,
		inspect: props.inspect,
		localProtocol: props.localProtocol,
		forceLocal: props.forceLocal,
	});

	useTunnel(toggles.tunnel);

	return (
		<>
			<DevSession {...props} local={toggles.local} />
			<Box borderStyle="round" paddingLeft={1} paddingRight={1}>
				<Text bold={true}>[b]</Text>
				<Text> open a browser, </Text>
				{props.inspect ? (
					<>
						<Text bold={true}>[d]</Text>
						<Text> open Devtools, </Text>
					</>
				) : null}
				{!props.forceLocal ? (
					<>
						<Text bold={true}>[l]</Text>
						<Text> {toggles.local ? "turn off" : "turn on"} local mode, </Text>
					</>
				) : null}
				<Text bold={true}>[c]</Text>
				<Text> clear console, </Text>
				<Text bold={true}>[x]</Text>
				<Text> to exit</Text>
			</Box>
		</>
	);
}

type DevSessionProps = DevProps & {
	local: boolean;
};

function DevSession(props: DevSessionProps) {
	useCustomBuild(props.entry, props.build);

	const directory = useTmpDir();

	const workerDefinitions = useDevRegistry(
		props.name,
		props.bindings.services,
		props.local ? "local" : "remote"
	);

	const bundle = useEsbuild({
		entry: props.entry,
		destination: directory,
		jsxFactory: props.jsxFactory,
		rules: props.rules,
		jsxFragment: props.jsxFragment,
		serveAssetsFromWorker: Boolean(
			props.assetPaths && !props.isWorkersSite && props.local
		),
		tsconfig: props.tsconfig,
		minify: props.minify,
		nodeCompat: props.nodeCompat,
		define: props.define,
		noBundle: props.noBundle,
		workerDefinitions,
		services: props.bindings.services,
	});

	return props.local ? (
		<Local
			name={props.name}
			bundle={bundle}
			format={props.entry.format}
			compatibilityDate={props.compatibilityDate}
			compatibilityFlags={props.compatibilityFlags}
			bindings={props.bindings}
			assetPaths={props.assetPaths}
			isWorkersSite={props.isWorkersSite}
			port={props.port}
			ip={props.ip}
			rules={props.rules}
			inspectorPort={props.inspectorPort}
			enableLocalPersistence={props.enableLocalPersistence}
			liveReload={props.liveReload}
			crons={props.crons}
			localProtocol={props.localProtocol}
			localUpstream={props.localUpstream}
			logLevel={props.logLevel}
			logPrefix={props.logPrefix}
			inspect={props.inspect}
			onReady={props.onReady}
			enablePagesAssetsServiceBinding={props.enablePagesAssetsServiceBinding}
		/>
	) : (
		<Remote
			name={props.name}
			bundle={bundle}
			format={props.entry.format}
			accountId={props.accountId}
			bindings={props.bindings}
			assetPaths={props.assetPaths}
			isWorkersSite={props.isWorkersSite}
			port={props.port}
			ip={props.ip}
			localProtocol={props.localProtocol}
			inspectorPort={props.inspectorPort}
			// TODO: @threepointone #1167
			// liveReload={props.liveReload}
			inspect={props.inspect}
			compatibilityDate={props.compatibilityDate}
			compatibilityFlags={props.compatibilityFlags}
			usageModel={props.usageModel}
			env={props.env}
			legacyEnv={props.legacyEnv}
			zone={props.zone}
			host={props.host}
			routes={props.routes}
			onReady={props.onReady}
		/>
	);
}

export interface DirectorySyncResult {
	name: string;
	removeCallback: () => void;
}

function useTmpDir(): string | undefined {
	const [directory, setDirectory] = useState<DirectorySyncResult>();
	const handleError = useErrorHandler();
	useEffect(() => {
		let dir: DirectorySyncResult | undefined;
		try {
			dir = tmp.dirSync({ unsafeCleanup: true });
			setDirectory(dir);
			return;
		} catch (err) {
			logger.error(
				"Failed to create temporary directory to store built files."
			);
			handleError(err);
		}
		return () => {
			dir?.removeCallback();
		};
	}, [handleError]);
	return directory?.name;
}

function useCustomBuild(expectedEntry: Entry, build: Config["build"]): void {
	useEffect(() => {
		if (!build.command) return;
		let watcher: ReturnType<typeof watch> | undefined;
		if (build.watch_dir) {
			watcher = watch(build.watch_dir, {
				persistent: true,
				ignoreInitial: true,
			}).on("all", (_event, filePath) => {
				const relativeFile =
					path.relative(expectedEntry.directory, expectedEntry.file) || ".";
				//TODO: we should buffer requests to the proxy until this completes
				logger.log(`The file ${filePath} changed, restarting build...`);
				runCustomBuild(expectedEntry.file, relativeFile, build).catch((err) => {
					logger.error("Custom build failed:", err);
				});
			});
		}

		return () => {
			watcher?.close();
		};
	}, [build, expectedEntry]);
}

function sleep(period: number) {
	return new Promise((resolve) => setTimeout(resolve, period));
}
const SLEEP_DURATION = 2000;
// really need a first class api for this
const hostNameRegex = /userHostname="(.*)"/g;
async function findTunnelHostname() {
	let hostName: string | undefined;
	while (!hostName) {
		try {
			const resp = await fetch("http://localhost:8789/metrics");
			const data = await resp.text();
			const matches = Array.from(data.matchAll(hostNameRegex));
			hostName = matches[0][1];
		} catch (err) {
			await sleep(SLEEP_DURATION);
		}
	}
	return hostName;
}

/**
 * Create a tunnel to the remote worker.
 * We've disabled this for now until we figure out a better user experience.
 */
function useTunnel(toggle: boolean) {
	const tunnel = useRef<ReturnType<typeof spawn>>();
	const removeSignalExitListener = useRef<() => void>();
	// TODO: test if cloudflared is available, if not
	// point them to a url where they can get docs to install it
	useEffect(() => {
		async function startTunnel() {
			if (toggle) {
				try {
					await commandExists("cloudflared");
				} catch (e) {
					logger.warn(
						"To share your worker on the Internet, please install `cloudflared` from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation"
					);
					return;
				}
				logger.log("⎔ Starting a tunnel...");
				tunnel.current = spawn("cloudflared", [
					"tunnel",
					"--url",
					"http://localhost:8787",
					"--metrics",
					"localhost:8789",
				]);

				tunnel.current.on("close", (code) => {
					if (code) {
						logger.log(`Tunnel process exited with code ${code}`);
					}
				});

				removeSignalExitListener.current = onExit((_code, _signal) => {
					logger.log("⎔ Shutting down local tunnel.");
					tunnel.current?.kill();
					tunnel.current = undefined;
				});

				const hostName = await findTunnelHostname();
				await clipboardy.write(hostName);
				logger.log(`⬣ Sharing at ${hostName}, copied to clipboard.`);
			}
		}

		startTunnel().catch(async (err) => {
			logger.error("tunnel:", err);
		});

		return () => {
			if (tunnel.current) {
				logger.log("⎔ Shutting down tunnel.");
				tunnel.current?.kill();
				tunnel.current = undefined;
				removeSignalExitListener.current && removeSignalExitListener.current();
				removeSignalExitListener.current = undefined;
			}
		};
	}, [toggle]);
}

type useHotkeysInitialState = {
	local: boolean;
	tunnel: boolean;
};
function useHotkeys(props: {
	initial: useHotkeysInitialState;
	port: number;
	ip: string;
	inspectorPort: number;
	inspect: boolean;
	localProtocol: "http" | "https";
	forceLocal: boolean | undefined;
}) {
	const {
		initial,
		port,
		ip,
		inspectorPort,
		inspect,
		localProtocol,
		forceLocal,
	} = props;
	// UGH, we should put port in context instead
	const [toggles, setToggles] = useState(initial);
	const { exit } = useApp();
	useInput(
		async (
			input,
			// eslint-disable-next-line unused-imports/no-unused-vars
			key
		) => {
			switch (input.toLowerCase()) {
				// clear console
				case "c":
					console.clear();
					// This console.log causes Ink to re-render the `DevSession` component.
					// Couldn't find a better way to tell it to do so...
					console.log();
					break;
				// open browser
				case "b": {
					await openInBrowser(`${localProtocol}://${ip}:${port}`);
					break;
				}
				// toggle inspector
				case "d": {
					if (inspect) {
						await openInspector(inspectorPort);
					}
					break;
				}
				// toggle local
				case "l":
					if (forceLocal) return;
					setToggles((previousToggles) => ({
						...previousToggles,
						local: !previousToggles.local,
					}));
					break;
				// shut down
				case "q":
				case "x":
					exit();
					break;
				default:
					// nothing?
					break;
			}
		}
	);
	return toggles;
}

function ErrorFallback(props: { error: Error }) {
	const { exit } = useApp();
	useEffect(() => exit(props.error));
	return (
		<>
			<Text>Something went wrong:</Text>
			<Text>{props.error.stack}</Text>
		</>
	);
}

export default withErrorBoundary(DevImplementation, {
	FallbackComponent: ErrorFallback,
});
