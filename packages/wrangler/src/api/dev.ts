import { startDev } from "../dev";
import { logger } from "../logger";

import type { EnablePagesAssetsServiceBindingOptions } from "../miniflare-cli";
import type { RequestInit, Response } from "undici";

interface DevOptions {
	env?: string;
	ip?: string;
	port?: number;
	localProtocol?: "http" | "https";
	assets?: string;
	site?: string;
	siteInclude?: string[];
	siteExclude?: string[];
	nodeCompat?: boolean;
	compatibilityDate?: string;
	experimentalEnableLocalPersistence?: boolean;
	liveReload?: boolean;
	watch?: boolean;
	vars: {
		[key: string]: unknown;
	};
	kv?: {
		binding: string;
		id: string;
		preview_id?: string;
	}[];
	durableObjects?: {
		name: string;
		class_name: string;
		script_name?: string | undefined;
		environment?: string | undefined;
	}[];
	d1?: {
		binding: string;
		database_name?: string;
		database_id?: string;
		preview_database_id?: string;
	}[];
	showInteractiveDevSession?: boolean;
	logLevel?: "none" | "error" | "log" | "warn" | "debug";
	logPrefix?: string;
	inspect?: boolean;
	forceLocal?: boolean;
	enablePagesAssetsServiceBinding?: EnablePagesAssetsServiceBindingOptions;
	_?: (string | number)[]; //yargs wants this
	$0?: string; //yargs wants this
}
/**
 *  unstable_dev starts a wrangler dev server, and returns a promise that resolves with utility functions to interact with it.
 *  @param {string} script
 *  @param {DevOptions} options
 */
export async function unstable_dev(
	script: string,
	options: DevOptions,
	disableExperimentalWarning?: boolean
) {
	if (!disableExperimentalWarning) {
		logger.warn(
			`unstable_dev() is experimental\nunstable_dev()'s behaviour will likely change in future releases`
		);
	}

	return new Promise<{
		stop: () => void;
		fetch: (init?: RequestInit) => Promise<Response | undefined>;
		waitUntilExit: () => Promise<void>;
	}>((resolve) => {
		//lmao
		return new Promise<Awaited<ReturnType<typeof startDev>>>((ready) => {
			const devServer = startDev({
				script: script,
				inspect: false,
				logLevel: "none",
				showInteractiveDevSession: false,
				_: [],
				$0: "",
				...options,
				local: true,
				onReady: () => ready(devServer),
			});
		}).then((devServer) => {
			resolve({
				stop: devServer.stop,
				fetch: devServer.fetch,
				waitUntilExit: devServer.devReactElement.waitUntilExit,
			});
		});
	});
}
