import { spawn } from "node:child_process";
import * as path from "node:path";
import { watch } from "chokidar";
import clipboardy from "clipboardy";
import commandExists from "command-exists";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import React, { useState, useEffect, useRef } from "react";
import { withErrorBoundary, useErrorHandler } from "react-error-boundary";
import onExit from "signal-exit";
import tmp from "tmp-promise";
import { fetch } from "undici";
import { runCustomBuild } from "../entry";
import { openInspector } from "../inspect";
import { logger } from "../logger";
import openInBrowser from "../open-in-browser";
import { getAPIToken } from "../user";
import { Local } from "./local";
import { Remote } from "./remote";
import { useEsbuild } from "./use-esbuild";
import type { Config } from "../config";
import type { Entry } from "../entry";
import type { AssetPaths } from "../sites";
import type { CfWorkerInit } from "../worker";
import type { EsbuildBundle } from "./use-esbuild";

export type DevProps = {
  name?: string;
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
  enableLocalPersistence: boolean;
  bindings: CfWorkerInit["bindings"];
  migrations: CfWorkerInit["migrations"];
  crons: Config["triggers"]["crons"];
  public: string | undefined;
  assetPaths: AssetPaths | undefined;
  compatibilityDate: string;
  compatibilityFlags: string[] | undefined;
  usageModel: "bundled" | "unbound" | undefined;
  minify: boolean | undefined;
  nodeCompat: boolean | undefined;
  build: {
    command?: string | undefined;
    cwd?: string | undefined;
    watch_dir?: string | undefined;
  };
  env: string | undefined;
  legacyEnv: boolean;
  zone:
    | {
        id: string;
        host: string;
      }
    | undefined;
};

export function DevImplementation(props: DevProps): JSX.Element {
  const apiToken = props.initialMode === "remote" ? getAPIToken() : undefined;
  const directory = useTmpDir();

  useCustomBuild(props.entry, props.build);

  if (props.public && props.entry.format === "service-worker") {
    throw new Error(
      "You cannot use the service-worker format with a `public` directory."
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

  const bundle = useEsbuild({
    entry: props.entry,
    destination: directory,
    staticRoot: props.public,
    jsxFactory: props.jsxFactory,
    rules: props.rules,
    jsxFragment: props.jsxFragment,
    serveAssetsFromWorker: !!props.public,
    tsconfig: props.tsconfig,
    minify: props.minify,
    nodeCompat: props.nodeCompat,
  });

  // only load the UI if we're running in a supported environment
  const { isRawModeSupported } = useStdin();
  return isRawModeSupported ? (
    <InteractiveDevSession {...props} bundle={bundle} apiToken={apiToken} />
  ) : (
    <DevSession
      {...props}
      bundle={bundle}
      apiToken={apiToken}
      local={props.initialMode === "local"}
    />
  );
}

type InteractiveDevSessionProps = DevProps & {
  apiToken: string | undefined;
  bundle: EsbuildBundle | undefined;
};

function InteractiveDevSession(props: InteractiveDevSessionProps) {
  const toggles = useHotkeys(
    {
      local: props.initialMode === "local",
      tunnel: false,
    },
    props.port,
    props.ip,
    props.inspectorPort,
    props.localProtocol
  );

  useTunnel(toggles.tunnel);

  return (
    <>
      <DevSession {...props} local={toggles.local} />
      <Box borderStyle="round" paddingLeft={1} paddingRight={1}>
        <Text bold={true}>[b]</Text>
        <Text> open a browser, </Text>
        <Text bold={true}>[d]</Text>
        <Text> open Devtools, </Text>
        <Text bold={true}>[l]</Text>
        <Text> {toggles.local ? "turn off" : "turn on"} local mode, </Text>
        <Text bold={true}>[c]</Text>
        <Text> clear console, </Text>
        <Text bold={true}>[x]</Text>
        <Text> to exit</Text>
      </Box>
    </>
  );
}

type DevSessionProps = InteractiveDevSessionProps & { local: boolean };

function DevSession(props: DevSessionProps) {
  return props.local ? (
    <Local
      name={props.name}
      bundle={props.bundle}
      format={props.entry.format}
      compatibilityDate={props.compatibilityDate}
      compatibilityFlags={props.compatibilityFlags}
      bindings={props.bindings}
      assetPaths={props.assetPaths}
      public={props.public}
      port={props.port}
      ip={props.ip}
      rules={props.rules}
      inspectorPort={props.inspectorPort}
      enableLocalPersistence={props.enableLocalPersistence}
      crons={props.crons}
    />
  ) : (
    <Remote
      name={props.name}
      bundle={props.bundle}
      format={props.entry.format}
      accountId={props.accountId}
      apiToken={props.apiToken}
      bindings={props.bindings}
      migrations={props.migrations}
      assetPaths={props.assetPaths}
      public={props.public}
      port={props.port}
      ip={props.ip}
      localProtocol={props.localProtocol}
      inspectorPort={props.inspectorPort}
      compatibilityDate={props.compatibilityDate}
      compatibilityFlags={props.compatibilityFlags}
      usageModel={props.usageModel}
      env={props.env}
      legacyEnv={props.legacyEnv}
      zone={props.zone}
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

function useCustomBuild(
  expectedEntry: Entry,
  build: {
    command?: string | undefined;
    cwd?: string | undefined;
    watch_dir?: string | undefined;
  }
): void {
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
function useHotkeys(
  initial: useHotkeysInitialState,
  port: number,
  ip: string,
  inspectorPort: number,
  localProtocol: "http" | "https"
) {
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
          await openInspector(inspectorPort);
          break;
        }
        // toggle local
        case "l":
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
