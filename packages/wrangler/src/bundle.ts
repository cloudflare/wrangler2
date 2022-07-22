import assert from "node:assert";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import NodeGlobalsPolyfills from "@esbuild-plugins/node-globals-polyfill";
import NodeModulesPolyfills from "@esbuild-plugins/node-modules-polyfill";
import * as esbuild from "esbuild";
import createModuleCollector from "./module-collection";
import type { Config } from "./config";
import type { Entry } from "./entry";
import type { CfModule } from "./worker";

type BundleResult = {
	modules: CfModule[];
	resolvedEntryPointPath: string;
	bundleType: "esm" | "commonjs";
	stop: (() => void) | undefined;
};

/**
 * Searches for any uses of node's builtin modules, and throws an error if it
 * finds anything. This plugin is only used when nodeCompat is not enabled.
 * Supports both regular node builtins, and the new "node:<MODULE>" format.
 */
const checkForNodeBuiltinsPlugin = {
	name: "checkForNodeBuiltins",
	setup(build: esbuild.PluginBuild) {
		build.onResolve(
			{
				filter: new RegExp(
					"^(" +
						builtinModules.join("|") +
						"|" +
						builtinModules.map((module) => "node:" + module).join("|") +
						")$"
				),
			},
			() => {
				throw new Error(
					`Detected a Node builtin module import while Node compatibility is disabled.\nAdd node_compat = true to your wrangler.toml file to enable Node compatibility.`
				);
			}
		);
	},
};

/**
 * Generate a bundle for the worker identified by the arguments passed in.
 */
export async function bundleWorker(
	entry: Entry,
	destination: string,
	options: {
		serveAssetsFromWorker: boolean;
		jsxFactory: string | undefined;
		jsxFragment: string | undefined;
		rules: Config["rules"];
		watch?: esbuild.WatchMode;
		tsconfig: string | undefined;
		minify: boolean | undefined;
		nodeCompat: boolean | undefined;
		define: Config["define"];
		checkFetch: boolean;
		firstPartyWorkerDevFacade: boolean | undefined;
	}
): Promise<BundleResult> {
	const {
		serveAssetsFromWorker,
		jsxFactory,
		jsxFragment,
		rules,
		watch,
		tsconfig,
		minify,
		nodeCompat,
		checkFetch,
		firstPartyWorkerDevFacade,
	} = options;
	const entryDirectory = path.dirname(entry.file);
	const moduleCollector = createModuleCollector({
		wrangler1xlegacyModuleReferences: {
			rootDirectory: entryDirectory,
			fileNames: new Set(
				fs
					.readdirSync(entryDirectory, { withFileTypes: true })
					.filter(
						(dirEntry) =>
							dirEntry.isFile() && dirEntry.name !== path.basename(entry.file)
					)
					.map((dirEnt) => dirEnt.name)
			),
		},
		format: entry.format,
		rules,
	});

	// In dev, we want to patch `fetch()` with a special version that looks
	// for bad usages and can warn the user about them; so we inject
	// `checked-fetch.js` to do so. However, with yarn 3 style pnp,
	// we need to extract that file to an accessible place before injecting
	// it in, hence this code here.
	const checkedFetchFileToInject = path.join(
		destination,
		"--temp-wrangler-files--",
		"checked-fetch.js"
	);

	if (checkFetch) {
		fs.mkdirSync(path.join(destination, "--temp-wrangler-files--"), {
			recursive: true,
		});
		fs.writeFileSync(
			checkedFetchFileToInject,
			fs.readFileSync(path.resolve(__dirname, "../templates/checked-fetch.js"))
		);
	}
	// TODO: we need to have similar logic like above for other files
	// like the static asset facade, and other middleware that we
	// plan on injecting/referencing.

	const result = await esbuild.build({
		...getEntryPoint(entry.file, {
			serveAssetsFromWorker,
			firstPartyWorkerDevFacade,
		}),
		bundle: true,
		absWorkingDir: entry.directory,
		outdir: destination,
		inject: checkFetch ? [checkedFetchFileToInject] : [],
		external: ["__STATIC_CONTENT_MANIFEST"],
		format: entry.format === "modules" ? "esm" : "iife",
		target: "es2020",
		sourcemap: true,
		minify,
		metafile: true,
		conditions: ["worker", "browser"],
		...(process.env.NODE_ENV && {
			define: {
				// use process.env["NODE_ENV" + ""] so that esbuild doesn't replace it
				// when we do a build of wrangler. (re: https://github.com/cloudflare/wrangler2/issues/1477)
				"process.env.NODE_ENV": `"${process.env["NODE_ENV" + ""]}"`,
				...(nodeCompat ? { global: "globalThis" } : {}),
				...(checkFetch ? { fetch: "checkedFetch" } : {}),
				...options.define,
			},
		}),
		loader: {
			".js": "jsx",
			".mjs": "jsx",
			".cjs": "jsx",
		},
		plugins: [
			moduleCollector.plugin,
			...(nodeCompat
				? [NodeGlobalsPolyfills({ buffer: true }), NodeModulesPolyfills()]
				: // we use checkForNodeBuiltinsPlugin to throw a nicer error
				  // if we find node builtins when nodeCompat isn't turned on
				  [checkForNodeBuiltinsPlugin]),
		],
		...(jsxFactory && { jsxFactory }),
		...(jsxFragment && { jsxFragment }),
		...(tsconfig && { tsconfig }),
		watch,
	});

	const entryPointOutputs = Object.entries(result.metafile.outputs).filter(
		([_path, output]) => output.entryPoint !== undefined
	);
	assert(
		entryPointOutputs.length > 0,
		`Cannot find entry-point "${entry.file}" in generated bundle.` +
			listEntryPoints(entryPointOutputs)
	);
	assert(
		entryPointOutputs.length < 2,
		"More than one entry-point found for generated bundle." +
			listEntryPoints(entryPointOutputs)
	);

	const entryPointExports = entryPointOutputs[0][1].exports;
	const bundleType = entryPointExports.length > 0 ? "esm" : "commonjs";

	return {
		modules: moduleCollector.modules,
		resolvedEntryPointPath: path.resolve(
			entry.directory,
			entryPointOutputs[0][0]
		),
		bundleType,
		stop: result.stop,
	};
}

type EntryPoint = { stdin: esbuild.StdinOptions } | { entryPoints: string[] };

/**
 * Create an object that describes the entry point for esbuild.
 *
 * If we are using the experimental asset handling, then the entry point is
 * actually a shim worker that will either return an asset from a KV store,
 * or delegate to the actual worker.
 */
function getEntryPoint(
	entryFile: string,
	options: {
		serveAssetsFromWorker: boolean;
		firstPartyWorkerDevFacade: boolean | undefined;
	}
): EntryPoint {
	if (options.serveAssetsFromWorker) {
		return {
			stdin: {
				contents: fs
					.readFileSync(
						path.join(__dirname, "../templates/static-asset-facade.js"),
						"utf8"
					)
					// on windows, escape backslashes in the path (`\`)
					.replace("__ENTRY_POINT__", entryFile.replaceAll("\\", "\\\\"))
					.replace(
						"__KV_ASSET_HANDLER__",
						path
							.join(__dirname, "../kv-asset-handler.js")
							.replaceAll("\\", "\\\\")
					),
				sourcefile: "static-asset-facade.js",
				resolveDir: path.dirname(entryFile),
			},
		};
	} else if (options.firstPartyWorkerDevFacade) {
		return {
			stdin: {
				contents: fs
					.readFileSync(
						path.join(
							__dirname,
							"../templates/first-party-worker-module-facade.ts"
						),
						"utf8"
					)
					// on windows, escape backslashes in the path (`\`)
					.replace("__ENTRY_POINT__", entryFile.replaceAll("\\", "\\\\")),
				sourcefile: "first-party-worker-module-facade.ts",
				resolveDir: path.dirname(entryFile),
				loader: "ts",
			},
		};
	} else {
		return { entryPoints: [entryFile] };
	}
}

/**
 * Generate a string that describes the entry-points that were identified by esbuild.
 */
function listEntryPoints(
	outputs: [string, ValueOf<esbuild.Metafile["outputs"]>][]
): string {
	return outputs.map(([_input, output]) => output.entryPoint).join("\n");
}

type ValueOf<T> = T[keyof T];
