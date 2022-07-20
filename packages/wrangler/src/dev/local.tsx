import { fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { useState, useEffect, useRef } from "react";
import onExit from "signal-exit";
import { registerWorker } from "../dev-registry";
import useInspector from "../inspect";
import { logger } from "../logger";
import { DEFAULT_MODULE_RULES } from "../module-collection";
import { waitForPortToBeAvailable } from "../proxy";
import type { Config } from "../config";
import type { EnablePagesAssetsServiceBindingOptions } from "../miniflare-cli";
import type { AssetPaths } from "../sites";
import type { CfWorkerInit, CfScriptFormat } from "../worker";
import type { EsbuildBundle } from "./use-esbuild";
import type { MiniflareOptions } from "miniflare";
import type { ChildProcess } from "node:child_process";
interface LocalProps {
	name: string | undefined;
	bundle: EsbuildBundle | undefined;
	format: CfScriptFormat | undefined;
	compatibilityDate: string;
	compatibilityFlags: string[] | undefined;
	bindings: CfWorkerInit["bindings"];
	assetPaths: AssetPaths | undefined;
	isWorkersSite: boolean;
	port: number;
	ip: string;
	rules: Config["rules"];
	inspectorPort: number;
	enableLocalPersistence: boolean;
	liveReload: boolean;
	crons: Config["triggers"]["crons"];
	localProtocol: "http" | "https";
	localUpstream: string | undefined;
	inspect: boolean;
	onReady: (() => void) | undefined;
	logLevel: "none" | "error" | "log" | "warn" | "debug" | undefined;
	logPrefix?: string;
	enablePagesAssetsServiceBinding?: EnablePagesAssetsServiceBindingOptions;
}

export function Local(props: LocalProps) {
	const { inspectorUrl } = useLocalWorker(props);
	useInspector({
		inspectorUrl,
		port: props.inspectorPort,
		logToTerminal: false,
	});
	return null;
}

function useLocalWorker({
	name: workerName,
	bundle,
	format,
	compatibilityDate,
	compatibilityFlags,
	bindings,
	assetPaths,
	isWorkersSite,
	port,
	inspectorPort,
	rules,
	enableLocalPersistence,
	liveReload,
	ip,
	crons,
	localProtocol,
	localUpstream,
	inspect,
	onReady,
	logLevel,
	logPrefix,
	enablePagesAssetsServiceBinding,
}: LocalProps) {
	// TODO: pass vars via command line
	const local = useRef<ChildProcess>();
	const removeSignalExitListener = useRef<() => void>();
	const [inspectorUrl, setInspectorUrl] = useState<string | undefined>();
	// if we're using local persistence for data, we should use the cwd
	// as an explicit path, or else it'll use the temp dir
	// which disappears when dev ends
	const localPersistencePath = enableLocalPersistence
		? // Maybe we could make the path configurable as well?
		  path.join(process.cwd(), "wrangler-local-state")
		: // We otherwise choose null, but choose true later
		  // so that it's persisted in the temp dir across a dev session
		  // even when we change source and reload
		  null;

	useEffect(() => {
		if (bindings.services && bindings.services.length > 0) {
			logger.warn(
				"⎔ Support for service bindings in local mode is experimental and may change."
			);
		}
	}, [bindings.services]);

	useEffect(() => {
		const abortController = new AbortController();
		async function startLocalWorker() {
			if (!bundle || !format) return;

			// port for the worker
			await waitForPortToBeAvailable(port, {
				retryPeriod: 200,
				timeout: 2000,
				abortSignal: abortController.signal,
			});

			// In local mode, we want to copy all referenced modules into
			// the output bundle directory before starting up
			for (const module of bundle.modules) {
				await writeFile(
					path.join(path.dirname(bundle.path), module.name),
					module.content
				);
			}

			const scriptPath = realpathSync(bundle.path);

			// the wasm_modules/text_blobs/data_blobs bindings are
			// relative to process.cwd(), but the actual worker bundle
			// is in the temp output directory; so we rewrite the paths to be absolute,
			// letting miniflare resolve them correctly

			// wasm
			const wasmBindings: Record<string, string> = {};
			for (const [name, filePath] of Object.entries(
				bindings.wasm_modules || {}
			)) {
				wasmBindings[name] = path.join(process.cwd(), filePath);
			}

			// text
			const textBlobBindings: Record<string, string> = {};
			for (const [name, filePath] of Object.entries(
				bindings.text_blobs || {}
			)) {
				textBlobBindings[name] = path.join(process.cwd(), filePath);
			}

			// data
			const dataBlobBindings: Record<string, string> = {};
			for (const [name, filePath] of Object.entries(
				bindings.data_blobs || {}
			)) {
				dataBlobBindings[name] = path.join(process.cwd(), filePath);
			}

			if (format === "service-worker") {
				for (const { type, name } of bundle.modules) {
					if (type === "compiled-wasm") {
						// In service-worker format, .wasm modules are referenced by global identifiers,
						// so we convert it here.
						// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
						// characters with an underscore.
						const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
						wasmBindings[identifier] = name;
					} else if (type === "text") {
						// In service-worker format, text modules are referenced by global identifiers,
						// so we convert it here.
						// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
						// characters with an underscore.
						const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
						textBlobBindings[identifier] = name;
					} else if (type === "buffer") {
						// In service-worker format, data blobs are referenced by global identifiers,
						// so we convert it here.
						// This identifier has to be a valid JS identifier, so we replace all non alphanumeric
						// characters with an underscore.
						const identifier = name.replace(/[^a-zA-Z0-9_$]/g, "_");
						dataBlobBindings[identifier] = name;
					}
				}
			}

			const upstream =
				typeof localUpstream === "string"
					? `${localProtocol}://${localUpstream}`
					: undefined;

			const options: MiniflareOptions = {
				name: workerName,
				port,
				scriptPath,
				https: localProtocol === "https",
				host: ip,
				modules: format === "modules",
				modulesRules: (rules || [])
					.concat(DEFAULT_MODULE_RULES)
					.map(({ type, globs: include, fallthrough }) => ({
						type,
						include,
						fallthrough,
					})),
				compatibilityDate,
				compatibilityFlags,
				kvNamespaces: bindings.kv_namespaces?.map((kv) => kv.binding),
				r2Buckets: bindings.r2_buckets?.map((r2) => r2.binding),
				durableObjects: Object.fromEntries(
					(bindings.durable_objects?.bindings ?? []).map<[string, string]>(
						(value) => [value.name, value.class_name]
					)
				),
				...(localPersistencePath
					? {
							cachePersist: path.join(localPersistencePath, "cache"),
							durableObjectsPersist: path.join(localPersistencePath, "do"),
							kvPersist: path.join(localPersistencePath, "kv"),
							r2Persist: path.join(localPersistencePath, "r2"),
					  }
					: {
							// We mark these as true, so that they'll
							// persist in the temp directory.
							// This means they'll persist across a dev session,
							// even if we change source and reload,
							// and be deleted when the dev session ends
							cachePersist: true,
							durableObjectsPersist: true,
							kvPersist: true,
							r2Persist: true,
					  }),

				liveReload,
				sitePath: assetPaths?.assetDirectory
					? path.join(assetPaths.baseDirectory, assetPaths.assetDirectory)
					: undefined,
				siteInclude: assetPaths?.includePatterns.length
					? assetPaths?.includePatterns
					: undefined,
				siteExclude: assetPaths?.excludePatterns.length
					? assetPaths.excludePatterns
					: undefined,
				bindings: bindings.vars,
				wasmBindings,
				textBlobBindings,
				dataBlobBindings,
				sourceMap: true,
				logUnhandledRejections: true,
				crons,
				upstream,
				disableLogs: logLevel === "none",
				logOptions: logPrefix ? { prefix: logPrefix } : undefined,
			};

			// The path to the Miniflare CLI assumes that this file is being run from
			// `wrangler-dist` and that the CLI is found in `miniflare-dist`.
			// If either of those paths change this line needs updating.
			const miniflareCLIPath = path.resolve(
				__dirname,
				"../miniflare-dist/index.mjs"
			);
			const miniflareOptions = JSON.stringify(options, null);

			logger.log("⎔ Starting a local server...");
			const nodeOptions = [
				"--experimental-vm-modules", // ensures that Miniflare can run ESM Workers
				"--no-warnings", // hide annoying Node warnings
				// "--log=VERBOSE", // uncomment this to Miniflare to log "everything"!
			];
			if (inspect) {
				nodeOptions.push("--inspect=" + `${ip}:${inspectorPort}`); // start Miniflare listening for a debugger to attach
			}

			const forkOptions = [miniflareOptions];

			if (enablePagesAssetsServiceBinding) {
				forkOptions.push(JSON.stringify(enablePagesAssetsServiceBinding));
			}

			const child = (local.current = fork(miniflareCLIPath, forkOptions, {
				cwd: path.dirname(scriptPath),
				execArgv: nodeOptions,
				stdio: "pipe",
			}));

			child.on("message", async (message) => {
				if (message === "ready") {
					// Let's register our presence in the dev registry
					if (workerName) {
						await registerWorker(workerName, {
							protocol: localProtocol,
							mode: "local",
							port,
							host: ip,
						});
					}
					onReady?.();
				}
			});

			child.on("close", (code) => {
				if (code) {
					logger.log(`Miniflare process exited with code ${code}`);
				}
			});

			child.stdout?.on("data", (data: Buffer) => {
				process.stdout.write(data);
			});

			// parse the node inspector url (which may be received in chunks) from stderr
			let stderrData = "";
			let inspectorUrlFound = false;
			child.stderr?.on("data", (data: Buffer) => {
				if (!inspectorUrlFound) {
					stderrData += data.toString();
					const matches =
						/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]+)[\r|\n]/.exec(
							stderrData
						);
					if (matches) {
						inspectorUrlFound = true;
						setInspectorUrl(matches[1]);
					}
				}

				process.stderr.write(data);
			});

			child.on("exit", (code) => {
				if (code) {
					logger.error(`Miniflare process exited with code ${code}`);
				}
			});

			child.on("error", (error: Error) => {
				logger.error(`Miniflare process failed to spawn`);
				logger.error(error);
			});

			removeSignalExitListener.current = onExit((_code, _signal) => {
				logger.log("⎔ Shutting down local server.");
				child.kill();
				local.current = undefined;
			});
		}

		startLocalWorker().catch((err) => {
			logger.error("local worker:", err);
		});

		return () => {
			abortController.abort();
			if (local.current) {
				logger.log("⎔ Shutting down local server.");
				local.current?.kill();
				local.current = undefined;
				removeSignalExitListener.current && removeSignalExitListener.current();
				removeSignalExitListener.current = undefined;
			}
		};
	}, [
		bundle,
		workerName,
		format,
		port,
		inspectorPort,
		ip,
		bindings.durable_objects?.bindings,
		bindings.kv_namespaces,
		bindings.r2_buckets,
		bindings.vars,
		bindings.services,
		compatibilityDate,
		compatibilityFlags,
		localPersistencePath,
		liveReload,
		assetPaths,
		isWorkersSite,
		rules,
		bindings.wasm_modules,
		bindings.text_blobs,
		bindings.data_blobs,
		crons,
		localProtocol,
		localUpstream,
		inspect,
		logLevel,
		logPrefix,
		onReady,
		enablePagesAssetsServiceBinding,
	]);
	return { inspectorUrl };
}
