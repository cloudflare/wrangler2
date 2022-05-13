import assert from "node:assert";
import { useApp } from "ink";
import { useState, useEffect } from "react";
import { bundleWorker } from "../bundle";
import { logger } from "../logger";
import type { Config } from "../config";
import type { Entry } from "../entry";
import type { CfModule } from "../worker";
import type { WatchMode } from "esbuild";

export type EsbuildBundle = {
	id: number;
	path: string;
	entry: Entry;
	type: "esm" | "commonjs";
	modules: CfModule[];
};

export function useEsbuild({
	entry,
	destination,
	jsxFactory,
	jsxFragment,
	rules,
	serveAssetsFromWorker,
	tsconfig,
	minify,
	nodeCompat,
	define,
}: {
	entry: Entry;
	destination: string | undefined;
	jsxFactory: string | undefined;
	jsxFragment: string | undefined;
	rules: Config["rules"];
	define: Config["define"];
	serveAssetsFromWorker: boolean;
	tsconfig: string | undefined;
	minify: boolean | undefined;
	nodeCompat: boolean | undefined;
}): EsbuildBundle | undefined {
	const [bundle, setBundle] = useState<EsbuildBundle>();
	const { exit } = useApp();
	useEffect(() => {
		let stopWatching: (() => void) | undefined = undefined;

		const watchMode: WatchMode = {
			async onRebuild(error) {
				if (error) logger.error("Watch build failed:", error);
				else {
					// nothing really changes here, so let's increment the id
					// to change the return object's identity
					setBundle((previousBundle) => {
						assert(
							previousBundle,
							"Rebuild triggered with no previous build available"
						);
						return { ...previousBundle, id: previousBundle.id + 1 };
					});
				}
			},
		};

		async function build() {
			if (!destination) return;

			const { resolvedEntryPointPath, bundleType, modules, stop } =
				await bundleWorker(entry, destination, {
					serveAssetsFromWorker,
					jsxFactory,
					jsxFragment,
					rules,
					watch: watchMode,
					tsconfig,
					minify,
					nodeCompat,
					define,
					checkFetch: true,
				});

			// Capture the `stop()` method to use as the `useEffect()` destructor.
			stopWatching = stop;

			setBundle({
				id: 0,
				entry,
				path: resolvedEntryPointPath,
				type: bundleType,
				modules,
			});
		}

		build().catch((err) => {
			// If esbuild fails on first run, we want to quit the process
			// since we can't recover from here
			// related: https://github.com/evanw/esbuild/issues/1037
			exit(err);
		});

		return () => {
			stopWatching?.();
		};
	}, [
		entry,
		destination,
		jsxFactory,
		jsxFragment,
		serveAssetsFromWorker,
		rules,
		tsconfig,
		exit,
		minify,
		nodeCompat,
		define,
	]);
	return bundle;
}
