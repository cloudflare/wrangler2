import fs from "node:fs";
import path from "node:path";
import { setup as createCloudflare } from "create-cloudflare";
import { initHandler } from "./init";
import { logger } from "./logger";
import { CommandLineArgsError, printWranglerBanner } from ".";
import type { Argv, ArgumentsCamelCase } from "yargs";

// https://github.com/cloudflare/wrangler/blob/master/src/cli/mod.rs#L106-L123
interface GenerateArgs {
	name?: string;
	template?: string;
	type?: string;
	site?: boolean;
}

export function generateOptions(yargs: Argv) {
	return yargs
		.positional("name", {
			describe: "Name of the Workers project",
			type: "string",
		})
		.positional("template", {
			type: "string",
			describe: "The URL of a GitHub template",
		})
		.option("type", {
			alias: "t",
			type: "boolean",
			hidden: true,
			deprecated: true,
		})
		.option("site", {
			alias: "s",
			type: "boolean",
			hidden: true,
			deprecated: true,
		});
}

export async function generateHandler({
	// somehow, `init` marks name as required but then also runs fine
	// with the name omitted, and then substitutes it at runtime with ""
	name = "",
	template,
	type,
	site,
	...args
}: ArgumentsCamelCase<GenerateArgs>) {
	// delegate to `wrangler init` if no template is specified
	if (template === undefined) {
		return initHandler({ name, ...args });
	}

	// print down here cuz `init` prints it own its own
	printWranglerBanner();

	if (type) {
		let message = "The --type option is no longer supported.";
		if (args.type === "webpack") {
			message +=
				"\nIf you wish to use webpack then you will need to create a custom build.";
			// TODO: Add a link to docs
		}
		throw new CommandLineArgsError(message);
	}

	const creationDirectory = generatedWorkerDir(name);

	if (site) {
		const gitDirectory =
			creationDirectory !== process.cwd()
				? path.basename(creationDirectory)
				: "my-site";
		const message =
			"The --site option is no longer supported.\n" +
			"If you wish to create a brand new Worker Sites project then clone the `worker-sites-template` starter repository:\n\n" +
			"```\n" +
			`git clone --depth=1 --branch=wrangler2 https://github.com/cloudflare/worker-sites-template ${gitDirectory}\n` +
			`cd ${gitDirectory}\n` +
			"```\n\n" +
			"Find out more about how to create and maintain Sites projects at https://developers.cloudflare.com/workers/platform/sites.\n" +
			"Have you considered using Cloudflare Pages instead? See https://pages.cloudflare.com/.";
		throw new CommandLineArgsError(message);
	}

	logger.log(
		`Creating a worker in ${path.basename(creationDirectory)} from ${template}`
	);

	await createCloudflare(creationDirectory, template, {
		init: true, // initialize a git repository
		debug: logger.loggerLevel === "debug",
		force: false, // do not overwrite an existing directory
	});
}

/**
 * Creates a path based on the current working directory and a worker name.
 * Automatically increments a counter when searching for an available directory.
 *
 * Running `wrangler generate worker https://some-git-repo` in a directory
 * with the structure:
 * ```
 * - workers
 * |
 * | - worker
 * | | - wrangler.toml
 * | | ...
 * |
 * | - worker-1
 * | | - wrangler.toml
 * | | ...
 * ```
 *
 * will result in a new worker called `worker-2` being generated.
 *
 * @param name the name of the generated worker
 * @returns an absolute path to the directory to generate the worker into
 */
function generatedWorkerDir(name: string): string {
	let workerDir = path.resolve(process.cwd(), name);
	let i = 1;
	while (fs.existsSync(workerDir)) {
		workerDir = path.resolve(process.cwd(), `${name}-${i}`);
		i++;
	}

	return workerDir;
}
