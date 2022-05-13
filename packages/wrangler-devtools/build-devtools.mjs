import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { execaSync } from "execa";

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(dirname, "built-devtools");

/**
 * Runs a given function in a temporary directory
 * @param {(...args: any[]) => any} fn a function to call
 * @returns `fn`, but run in a temporary directory
 */
const inTempDir = (fn) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-devtools"));
  const cwd = process.cwd();

  return (...args) => {
    process.chdir(tempDir);
    const result = fn(...args);
    process.chdir(cwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return result;
  };
};

/**
 * Installs [`depot_tools`](https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools_tutorial.html#_setting_up), which is
 * necessary to build `chrome-devtools-frontend`,
 * @returns paths to the `fetch`, `gn`, and `autoninja` executables
 */
function installDepotTools() {
  if (os.platform() === "win32") {
    throw new Error("please only build devtools on unix for now");
  }

  const status = execaSync("git", [
    "clone",
    "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
  ]);
  if (status.failed) {
    throw new Error(status.stderr);
  }

  const depotToolsPath = path.resolve(process.cwd(), "depot_tools");
  const fetch = path.join(depotToolsPath, "fetch");
  const gn = path.join(depotToolsPath, "gn");
  const autoninja = path.join(depotToolsPath, "autoninja");
  return { fetch, gn, autoninja };
}

/**
 * Clone the devtools repository
 * @param {string} fetch path to the `fetch` tool from `depot_tools`
 */
function checkoutDevtools(fetch) {
  const result = execaSync(fetch, ["devtools-frontend"]);
  if (result.failed) {
    throw new Error(result.stderr);
  }
}

/**
 *
 * @param {string} gn path to the `gn` tool from `depot_tools`
 * @param {string} autoninja path to the `autoninja` tool from `depot_tools`
 * @returns the path to the directory containing the built output
 */
function buildDevtools(gn, autoninja) {
  const outDir = path.join("out", "Default");

  const gnResult = execaSync(gn, ["gen", outDir]);
  if (gnResult.failed) {
    throw new Error(gnResult.stderr);
  }

  const autoninjaResult = execaSync(autoninja, ["-C", outDir]);
  if (autoninjaResult.failed) {
    throw new Error(autoninjaResult.stderr);
  }

  const builtDevToolsPath = path.resolve(
    process.cwd(),
    outDir,
    "gen",
    "front_end"
  );
  return builtDevToolsPath;
}

const runDevtoolsBuild = inTempDir((outputDir) => {
  const { fetch, gn, autoninja } = installDepotTools();

  fs.mkdirSync("devtools");
  process.chdir("devtools");
  checkoutDevtools(fetch);

  process.chdir("devtools-frontend");
  const builtDevToolsPath = buildDevtools(gn, autoninja);

  // copy files
  fs.cpSync(builtDevToolsPath, outputDir, { recursive: true });
});

runDevtoolsBuild(OUTPUT_DIR);
