/* eslint-disable no-shadow */

import { execSync, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep, extname, basename } from "node:path";
import { cwd } from "node:process";
import { URL } from "node:url";
import { hash } from "blake3-wasm";
import { watch } from "chokidar";
import { render, Text } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import Table from "ink-table";
import { getType } from "mime";
import PQueue from "p-queue";
import prettyBytes from "pretty-bytes";
import React from "react";
import { format as timeagoFormat } from "timeago.js";
import { File, FormData } from "undici";
import { buildPlugin } from "../pages/functions/buildPlugin";
import { buildWorker } from "../pages/functions/buildWorker";
import { generateConfigFromFileTree } from "../pages/functions/filepath-routing";
import { writeRoutesModule } from "../pages/functions/routes";
import { fetchResult } from "./cfetch";
import { getConfigCache, saveToConfigCache } from "./config-cache";
import { prompt } from "./dialogs";
import { FatalError } from "./errors";
import { logger } from "./logger";
import { getRequestContextCheckOptions } from "./miniflare-cli/request-context";
import openInBrowser from "./open-in-browser";
import { toUrlPath } from "./paths";
import { requireAuth } from "./user";
import type { Config } from "../pages/functions/routes";
import type {
  Headers as MiniflareHeaders,
  Request as MiniflareRequest,
  fetch as miniflareFetch,
} from "@miniflare/core";
import type { BuildResult } from "esbuild";
import type { MiniflareOptions } from "miniflare";
import type { BuilderCallback, CommandModule } from "yargs";

export type Project = {
  name: string;
  subdomain: string;
  domains: Array<string>;
  source?: {
    type: string;
  };
  latest_deployment?: {
    modified_on: string;
  };
  created_on: string;
  production_branch: string;
};

export type Deployment = {
  id: string;
  environment: string;
  deployment_trigger: {
    metadata: {
      commit_hash: string;
      branch: string;
    };
  };
  url: string;
  latest_stage: {
    status: string;
    ended_on: string;
  };
  project_name: string;
};

export type UploadPayloadFile = {
  key: string;
  value: string;
  metadata: { contentType: string };
  base64: boolean;
};

interface PagesConfigCache {
  account_id?: string;
  project_name?: string;
}

const PAGES_CONFIG_CACHE_FILENAME = "pages.json";
const MAX_BUCKET_SIZE = 50 * 1024 * 1024;
const MAX_BUCKET_FILE_COUNT = 5000;
const BULK_UPLOAD_CONCURRENCY = 3;
const MAX_UPLOAD_ATTEMPTS = 5;

// Defer importing miniflare until we really need it. This takes ~0.5s
// and also modifies some `stream/web` and `undici` prototypes, so we
// don't want to do this if pages commands aren't being called.

export const pagesBetaWarning =
  "🚧 'wrangler pages <command>' is a beta command. Please report any issues to https://github.com/cloudflare/wrangler2/issues/new/choose";

const isInPagesCI = !!process.env.CF_PAGES;

const CLEANUP_CALLBACKS: (() => void)[] = [];
const CLEANUP = () => {
  CLEANUP_CALLBACKS.forEach((callback) => callback());
  RUNNING_BUILDERS.forEach((builder) => builder.stop?.());
};

process.on("SIGINT", () => {
  CLEANUP();
  process.exit();
});
process.on("SIGTERM", () => {
  CLEANUP();
  process.exit();
});

function isWindows() {
  return process.platform === "win32";
}

const SECONDS_TO_WAIT_FOR_PROXY = 5;
const DURABLE_OBJECTS_BINDING_REGEXP = new RegExp(
  /^(?<binding>[^=]+)=(?<className>[^@\s]+)(@(?<scriptName>.*)$)?$/
);

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
}): Promise<void | number> {
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
      .filter((port) => port !== undefined)[0];

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

function escapeRegex(str: string) {
  return str.replace(/[-/\\^$*+?.()|[]{}]/g, "\\$&");
}

type Replacements = Record<string, string>;

function replacer(str: string, replacements: Replacements) {
  for (const [replacement, value] of Object.entries(replacements)) {
    str = str.replace(`:${replacement}`, value);
  }
  return str;
}

function generateRulesMatcher<T>(
  rules?: Record<string, T>,
  replacer: (match: T, replacements: Replacements) => T = (match) => match
) {
  // TODO: How can you test cross-host rules?
  if (!rules) return () => [];

  const compiledRules = Object.entries(rules)
    .map(([rule, match]) => {
      const crossHost = rule.startsWith("https://");

      rule = rule.split("*").map(escapeRegex).join("(?<splat>.*)");

      const host_matches = rule.matchAll(
        /(?<=^https:\\\/\\\/[^/]*?):([^\\]+)(?=\\)/g
      );
      for (const match of host_matches) {
        rule = rule.split(match[0]).join(`(?<${match[1]}>[^/.]+)`);
      }

      const path_matches = rule.matchAll(/:(\w+)/g);
      for (const match of path_matches) {
        rule = rule.split(match[0]).join(`(?<${match[1]}>[^/]+)`);
      }

      rule = "^" + rule + "$";

      try {
        const regExp = new RegExp(rule);
        return [{ crossHost, regExp }, match];
      } catch {}
    })
    .filter((value) => value !== undefined) as [
    { crossHost: boolean; regExp: RegExp },
    T
  ][];

  return ({ request }: { request: MiniflareRequest }) => {
    const { pathname, host } = new URL(request.url);

    return compiledRules
      .map(([{ crossHost, regExp }, match]) => {
        const test = crossHost ? `https://${host}${pathname}` : pathname;
        const result = regExp.exec(test);
        if (result) {
          return replacer(match, result.groups || {});
        }
      })
      .filter((value) => value !== undefined) as T[];
  };
}

function generateHeadersMatcher(headersFile: string) {
  if (existsSync(headersFile)) {
    const contents = readFileSync(headersFile).toString();

    // TODO: Log errors
    const lines = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#") && line !== "");

    const rules: Record<string, Record<string, string>> = {};
    let rule: { path: string; headers: Record<string, string> } | undefined =
      undefined;

    for (const line of lines) {
      if (/^([^\s]+:\/\/|^\/)/.test(line)) {
        if (rule && Object.keys(rule.headers).length > 0) {
          rules[rule.path] = rule.headers;
        }

        const path = validateURL(line);
        if (path) {
          rule = {
            path,
            headers: {},
          };
          continue;
        }
      }

      if (!line.includes(":")) continue;

      const [rawName, ...rawValue] = line.split(":");
      const name = rawName.trim().toLowerCase();
      const value = rawValue.join(":").trim();

      if (name === "") continue;
      if (!rule) continue;

      const existingValues = rule.headers[name];
      rule.headers[name] = existingValues
        ? `${existingValues}, ${value}`
        : value;
    }

    if (rule && Object.keys(rule.headers).length > 0) {
      rules[rule.path] = rule.headers;
    }

    const rulesMatcher = generateRulesMatcher(rules, (match, replacements) =>
      Object.fromEntries(
        Object.entries(match).map(([name, value]) => [
          name,
          replacer(value, replacements),
        ])
      )
    );

    return (request: MiniflareRequest) => {
      const matches = rulesMatcher({
        request,
      });
      if (matches) return matches;
    };
  } else {
    return () => undefined;
  }
}

function generateRedirectsMatcher(redirectsFile: string) {
  if (existsSync(redirectsFile)) {
    const contents = readFileSync(redirectsFile).toString();

    // TODO: Log errors
    const lines = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#") && line !== "");

    const rules = Object.fromEntries(
      lines
        .map((line) => line.split(" "))
        .filter((tokens) => tokens.length === 2 || tokens.length === 3)
        .map((tokens) => {
          const from = validateURL(tokens[0], true, false, false);
          const to = validateURL(tokens[1], false, true, true);
          let status: number | undefined = parseInt(tokens[2]) || 302;
          status = [301, 302, 303, 307, 308].includes(status)
            ? status
            : undefined;

          return from && to && status ? [from, { to, status }] : undefined;
        })
        .filter((rule) => rule !== undefined) as [
        string,
        { to: string; status?: number }
      ][]
    );

    const rulesMatcher = generateRulesMatcher(
      rules,
      ({ status, to }, replacements) => ({
        status,
        to: replacer(to, replacements),
      })
    );

    return (request: MiniflareRequest) => {
      const match = rulesMatcher({
        request,
      })[0];
      if (match) return match;
    };
  } else {
    return () => undefined;
  }
}

function extractPathname(
  path = "/",
  includeSearch: boolean,
  includeHash: boolean
) {
  if (!path.startsWith("/")) path = `/${path}`;
  const url = new URL(`//${path}`, "relative://");
  return `${url.pathname}${includeSearch ? url.search : ""}${
    includeHash ? url.hash : ""
  }`;
}

function validateURL(
  token: string,
  onlyRelative = false,
  includeSearch = false,
  includeHash = false
) {
  const host = /^https:\/\/+(?<host>[^/]+)\/?(?<path>.*)/.exec(token);
  if (host && host.groups && host.groups.host) {
    if (onlyRelative) return;

    return `https://${host.groups.host}${extractPathname(
      host.groups.path,
      includeSearch,
      includeHash
    )}`;
  } else {
    if (!token.startsWith("/") && onlyRelative) token = `/${token}`;

    const path = /^\//.exec(token);
    if (path) {
      try {
        return extractPathname(token, includeSearch, includeHash);
      } catch {}
    }
  }
  return "";
}

function hasFileExtension(pathname: string) {
  return /\/.+\.[a-z0-9]+$/i.test(pathname);
}

async function generateAssetsFetch(
  directory: string
): Promise<typeof miniflareFetch> {
  // Defer importing miniflare until we really need it
  const { Headers, Request, Response } = await import("@miniflare/core");

  const headersFile = join(directory, "_headers");
  const redirectsFile = join(directory, "_redirects");
  const workerFile = join(directory, "_worker.js");

  const ignoredFiles = [headersFile, redirectsFile, workerFile];

  const assetExists = (path: string) => {
    path = join(directory, path);
    return (
      existsSync(path) &&
      lstatSync(path).isFile() &&
      !ignoredFiles.includes(path)
    );
  };

  const getAsset = (path: string) => {
    if (assetExists(path)) {
      return join(directory, path);
    }
  };

  let redirectsMatcher = generateRedirectsMatcher(redirectsFile);
  let headersMatcher = generateHeadersMatcher(headersFile);

  watch([headersFile, redirectsFile], {
    persistent: true,
  }).on("change", (path) => {
    switch (path) {
      case headersFile: {
        logger.log("_headers modified. Re-evaluating...");
        headersMatcher = generateHeadersMatcher(headersFile);
        break;
      }
      case redirectsFile: {
        logger.log("_redirects modified. Re-evaluating...");
        redirectsMatcher = generateRedirectsMatcher(redirectsFile);
        break;
      }
    }
  });

  const serveAsset = (file: string) => {
    return readFileSync(file);
  };

  const generateResponse = (request: MiniflareRequest) => {
    const url = new URL(request.url);

    const deconstructedResponse: {
      status: number;
      headers: MiniflareHeaders;
      body?: Buffer;
    } = {
      status: 200,
      headers: new Headers(),
      body: undefined,
    };

    const match = redirectsMatcher(request);
    if (match) {
      const { status, to } = match;

      let location = to;
      let search;

      if (to.startsWith("/")) {
        search = new URL(location, "http://fakehost").search;
      } else {
        search = new URL(location).search;
      }

      location = `${location}${search ? "" : url.search}`;

      if (status && [301, 302, 303, 307, 308].includes(status)) {
        deconstructedResponse.status = status;
      } else {
        deconstructedResponse.status = 302;
      }

      deconstructedResponse.headers.set("Location", location);
      return deconstructedResponse;
    }

    if (!request.method?.match(/^(get|head)$/i)) {
      deconstructedResponse.status = 405;
      return deconstructedResponse;
    }

    const notFound = () => {
      let cwd = url.pathname;
      while (cwd) {
        cwd = cwd.slice(0, cwd.lastIndexOf("/"));

        if ((asset = getAsset(`${cwd}/404.html`))) {
          deconstructedResponse.status = 404;
          deconstructedResponse.body = serveAsset(asset);
          deconstructedResponse.headers.set(
            "Content-Type",
            getType(asset) || "application/octet-stream"
          );
          return deconstructedResponse;
        }
      }

      if ((asset = getAsset(`/index.html`))) {
        deconstructedResponse.body = serveAsset(asset);
        deconstructedResponse.headers.set(
          "Content-Type",
          getType(asset) || "application/octet-stream"
        );
        return deconstructedResponse;
      }

      deconstructedResponse.status = 404;
      return deconstructedResponse;
    };

    let asset;

    if (url.pathname.endsWith("/")) {
      if ((asset = getAsset(`${url.pathname}/index.html`))) {
        deconstructedResponse.body = serveAsset(asset);
        deconstructedResponse.headers.set(
          "Content-Type",
          getType(asset) || "application/octet-stream"
        );
        return deconstructedResponse;
      } else if (
        (asset = getAsset(`${url.pathname.replace(/\/$/, ".html")}`))
      ) {
        deconstructedResponse.status = 301;
        deconstructedResponse.headers.set(
          "Location",
          `${url.pathname.slice(0, -1)}${url.search}`
        );
        return deconstructedResponse;
      }
    }

    if (url.pathname.endsWith("/index")) {
      deconstructedResponse.status = 301;
      deconstructedResponse.headers.set(
        "Location",
        `${url.pathname.slice(0, -"index".length)}${url.search}`
      );
      return deconstructedResponse;
    }

    if ((asset = getAsset(url.pathname))) {
      if (url.pathname.endsWith(".html")) {
        const extensionlessPath = url.pathname.slice(0, -".html".length);
        if (getAsset(extensionlessPath) || extensionlessPath === "/") {
          deconstructedResponse.body = serveAsset(asset);
          deconstructedResponse.headers.set(
            "Content-Type",
            getType(asset) || "application/octet-stream"
          );
          return deconstructedResponse;
        } else {
          deconstructedResponse.status = 301;
          deconstructedResponse.headers.set(
            "Location",
            `${extensionlessPath}${url.search}`
          );
          return deconstructedResponse;
        }
      } else {
        deconstructedResponse.body = serveAsset(asset);
        deconstructedResponse.headers.set(
          "Content-Type",
          getType(asset) || "application/octet-stream"
        );
        return deconstructedResponse;
      }
    } else if (hasFileExtension(url.pathname)) {
      notFound();
      return deconstructedResponse;
    }

    if ((asset = getAsset(`${url.pathname}.html`))) {
      deconstructedResponse.body = serveAsset(asset);
      deconstructedResponse.headers.set(
        "Content-Type",
        getType(asset) || "application/octet-stream"
      );
      return deconstructedResponse;
    }

    if ((asset = getAsset(`${url.pathname}/index.html`))) {
      deconstructedResponse.status = 301;
      deconstructedResponse.headers.set(
        "Location",
        `${url.pathname}/${url.search}`
      );
      return deconstructedResponse;
    } else {
      notFound();
      return deconstructedResponse;
    }
  };

  const attachHeaders = (
    request: MiniflareRequest,
    deconstructedResponse: {
      status: number;
      headers: MiniflareHeaders;
      body?: Buffer;
    }
  ) => {
    const headers = deconstructedResponse.headers;
    const newHeaders = new Headers({});
    const matches = headersMatcher(request) || [];

    matches.forEach((match) => {
      Object.entries(match).forEach(([name, value]) => {
        newHeaders.append(name, `${value}`);
      });
    });

    const combinedHeaders = {
      ...Object.fromEntries(headers.entries()),
      ...Object.fromEntries(newHeaders.entries()),
    };

    deconstructedResponse.headers = new Headers({});
    Object.entries(combinedHeaders).forEach(([name, value]) => {
      if (value) deconstructedResponse.headers.set(name, value);
    });
  };

  return async (input, init) => {
    const request = new Request(input, init);
    const deconstructedResponse = generateResponse(request);
    attachHeaders(request, deconstructedResponse);

    const headers = new Headers();

    [...deconstructedResponse.headers.entries()].forEach(([name, value]) => {
      if (value) headers.set(name, value);
    });

    return new Response(deconstructedResponse.body, {
      headers,
      status: deconstructedResponse.status,
    });
  };
}

const RUNNING_BUILDERS: BuildResult[] = [];

async function buildFunctions({
  outfile,
  outputConfigPath,
  functionsDirectory,
  minify = false,
  sourcemap = false,
  fallbackService = "ASSETS",
  watch = false,
  onEnd,
  plugin = false,
  buildOutputDirectory,
  nodeCompat,
}: {
  outfile: string;
  outputConfigPath?: string;
  functionsDirectory: string;
  minify?: boolean;
  sourcemap?: boolean;
  fallbackService?: string;
  watch?: boolean;
  onEnd?: () => void;
  plugin?: boolean;
  buildOutputDirectory?: string;
  nodeCompat?: boolean;
}) {
  RUNNING_BUILDERS.forEach(
    (runningBuilder) => runningBuilder.stop && runningBuilder.stop()
  );

  const routesModule = join(tmpdir(), `./functionsRoutes-${Math.random()}.mjs`);
  const baseURL = toUrlPath("/");

  const config: Config = await generateConfigFromFileTree({
    baseDir: functionsDirectory,
    baseURL,
  });

  if (outputConfigPath) {
    writeFileSync(
      outputConfigPath,
      JSON.stringify({ ...config, baseURL }, null, 2)
    );
  }

  await writeRoutesModule({
    config,
    srcDir: functionsDirectory,
    outfile: routesModule,
  });

  if (plugin) {
    RUNNING_BUILDERS.push(
      await buildPlugin({
        routesModule,
        outfile,
        minify,
        sourcemap,
        watch,
        nodeCompat,
        onEnd,
      })
    );
  } else {
    RUNNING_BUILDERS.push(
      await buildWorker({
        routesModule,
        outfile,
        minify,
        sourcemap,
        fallbackService,
        watch,
        onEnd,
        buildOutputDirectory,
        nodeCompat,
      })
    );
  }
}

interface CreateDeploymentArgs {
  directory: string;
  projectName?: string;
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
  commitDirty?: boolean;
}

const upload = async ({
  directory,
  accountId,
  projectName,
}: {
  directory: string;
  accountId: string;
  projectName: string;
}) => {
  type FileContainer = {
    content: string;
    contentType: string;
    sizeInBytes: number;
    hash: string;
  };

  const IGNORE_LIST = [
    "_worker.js",
    "_redirects",
    "_headers",
    ".DS_Store",
    "node_modules",
    ".git",
  ];

  const walk = async (
    dir: string,
    fileMap: Map<string, FileContainer> = new Map(),
    depth = 0
  ) => {
    const files = await readdir(dir);

    await Promise.all(
      files.map(async (file) => {
        const filepath = join(dir, file);
        const filestat = await stat(filepath);

        if (IGNORE_LIST.includes(file)) {
          return;
        }

        if (filestat.isSymbolicLink()) {
          return;
        }

        if (filestat.isDirectory()) {
          fileMap = await walk(filepath, fileMap, depth + 1);
        } else {
          let name;
          if (depth) {
            name = filepath.split(sep).slice(1).join("/");
          } else {
            name = file;
          }

          // TODO: Move this to later so we don't hold as much in memory
          const fileContent = await readFile(filepath);

          const base64Content = fileContent.toString("base64");
          const extension = extname(basename(name)).substring(1);

          if (filestat.size > 25 * 1024 * 1024) {
            throw new Error(
              `Error: Pages only supports files up to ${prettyBytes(
                25 * 1024 * 1024
              )} in size\n${name} is ${prettyBytes(filestat.size)} in size`
            );
          }

          fileMap.set(name, {
            content: base64Content,
            contentType: getType(name) || "application/octet-stream",
            sizeInBytes: filestat.size,
            hash: hash(base64Content + extension)
              .toString("hex")
              .slice(0, 32),
          });
        }
      })
    );

    return fileMap;
  };

  const fileMap = await walk(directory);

  if (fileMap.size > 20000) {
    throw new FatalError(
      `Error: Pages only supports up to 20,000 files in a deployment. Ensure you have specified your build output directory correctly.`,
      1
    );
  }

  const files = [...fileMap.values()];

  async function fetchJwt(): Promise<string> {
    return (
      await fetchResult<{ jwt: string }>(
        `/accounts/${accountId}/pages/projects/${projectName}/upload-token`
      )
    ).jwt;
  }

  let jwt = await fetchJwt();

  const start = Date.now();

  const missingHashes = await fetchResult<string[]>(
    `/pages/assets/check-missing`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        hashes: files.map(({ hash }) => hash),
      }),
    }
  );

  const sortedFiles = files
    .filter((file) => missingHashes.includes(file.hash))
    .sort((a, b) => b.sizeInBytes - a.sizeInBytes);

  // Start with a few buckets so small projects still get
  // the benefit of multiple upload streams
  const buckets: {
    files: FileContainer[];
    remainingSize: number;
  }[] = new Array(BULK_UPLOAD_CONCURRENCY).fill(null).map(() => ({
    files: [],
    remainingSize: MAX_BUCKET_SIZE,
  }));

  let bucketOffset = 0;
  for (const file of sortedFiles) {
    let inserted = false;

    for (let i = 0; i < buckets.length; i++) {
      // Start at a different bucket for each new file
      const bucket = buckets[(i + bucketOffset) % buckets.length];
      if (
        bucket.remainingSize >= file.sizeInBytes &&
        bucket.files.length < MAX_BUCKET_FILE_COUNT
      ) {
        bucket.files.push(file);
        bucket.remainingSize -= file.sizeInBytes;
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      buckets.push({
        files: [file],
        remainingSize: MAX_BUCKET_SIZE - file.sizeInBytes,
      });
    }
    bucketOffset++;
  }

  let counter = fileMap.size - sortedFiles.length;
  const { rerender, unmount } = render(
    <Progress done={counter} total={fileMap.size} />
  );

  const queue = new PQueue({ concurrency: BULK_UPLOAD_CONCURRENCY });

  for (const bucket of buckets) {
    // Don't upload empty buckets (can happen for tiny projects)
    if (bucket.files.length === 0) continue;

    const payload: UploadPayloadFile[] = bucket.files.map((file) => ({
      key: file.hash,
      value: file.content,
      metadata: {
        contentType: file.contentType,
      },
      base64: true,
    }));

    let attempts = 0;
    const doUpload = async (): Promise<void> => {
      try {
        return await fetchResult(`/pages/assets/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        if (attempts < MAX_UPLOAD_ATTEMPTS) {
          // Linear backoff, 0 second first time, then 1 second etc.
          await new Promise((resolve) =>
            setTimeout(resolve, attempts++ * 1000)
          );

          if ((e as { code: number }).code === 8000013) {
            // Looks like the JWT expired, fetch another one
            jwt = await fetchJwt();
          }
          return doUpload();
        } else {
          throw e;
        }
      }
    };

    queue.add(() =>
      doUpload().then(
        () => {
          counter += bucket.files.length;
          rerender(<Progress done={counter} total={fileMap.size} />);
        },
        (error) => {
          return Promise.reject(
            new FatalError(
              "Failed to upload files. Please try again.",
              error.code || 1
            )
          );
        }
      )
    );
  }

  await queue.onIdle();

  unmount();

  const uploadMs = Date.now() - start;

  const skipped = fileMap.size - missingHashes.length;
  const skippedMessage = skipped > 0 ? `(${skipped} already uploaded) ` : "";

  logger.log(
    `✨ Success! Uploaded ${
      sortedFiles.length
    } files ${skippedMessage}${formatTime(uploadMs)}\n`
  );

  const doUpsertHashes = async (): Promise<void> => {
    try {
      return await fetchResult(`/pages/assets/upsert-hashes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          hashes: files.map(({ hash }) => hash),
        }),
      });
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if ((e as { code: number }).code === 8000013) {
        // Looks like the JWT expired, fetch another one
        jwt = await fetchJwt();
      }

      return await fetchResult(`/pages/assets/upsert-hashes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          hashes: files.map(({ hash }) => hash),
        }),
      });
    }
  };

  try {
    await doUpsertHashes();
  } catch {
    logger.warn(
      "Failed to update file hashes. Every upload appeared to succeed for this deployment, but you might need to re-upload for future deployments. This shouldn't have any impact other than slowing the upload speed of your next deployment."
    );
  }

  return Object.fromEntries(
    [...fileMap.entries()].map(([fileName, file]) => [
      `/${fileName}`,
      file.hash,
    ])
  );
};

const createDeployment: CommandModule<
  CreateDeploymentArgs,
  CreateDeploymentArgs
> = {
  describe: "🆙 Publish a directory of static assets as a Pages deployment",
  builder: (yargs) => {
    return yargs
      .positional("directory", {
        type: "string",
        demandOption: true,
        description: "The directory of static files to upload",
      })
      .options({
        "project-name": {
          type: "string",
          description: "The name of the project you want to deploy to",
        },
        branch: {
          type: "string",
          description: "The name of the branch you want to deploy to",
        },
        "commit-hash": {
          type: "string",
          description: "The SHA to attach to this deployment",
        },
        "commit-message": {
          type: "string",
          description: "The commit message to attach to this deployment",
        },
        "commit-dirty": {
          type: "boolean",
          description:
            "Whether or not the workspace should be considered dirty for this deployment",
        },
      })
      .epilogue(pagesBetaWarning);
  },
  handler: async ({
    directory,
    projectName,
    branch,
    commitHash,
    commitMessage,
    commitDirty,
  }) => {
    if (!directory) {
      throw new FatalError("Must specify a directory.", 1);
    }

    const config = getConfigCache<PagesConfigCache>(
      PAGES_CONFIG_CACHE_FILENAME
    );
    const accountId = await requireAuth(config);

    projectName ??= config.project_name;

    const isInteractive = process.stdin.isTTY;
    if (!projectName && isInteractive) {
      const projects = (await listProjects({ accountId })).filter(
        (project) => !project.source
      );

      let existingOrNew: "existing" | "new" = "new";

      if (projects.length > 0) {
        existingOrNew = await new Promise<"new" | "existing">((resolve) => {
          const { unmount } = render(
            <>
              <Text>
                No project selected. Would you like to create one or use an
                existing project?
              </Text>
              <SelectInput
                items={[
                  {
                    key: "new",
                    label: "Create a new project",
                    value: "new",
                  },
                  {
                    key: "existing",
                    label: "Use an existing project",
                    value: "existing",
                  },
                ]}
                onSelect={async (selected) => {
                  resolve(selected.value as "new" | "existing");
                  unmount();
                }}
              />
            </>
          );
        });
      }

      switch (existingOrNew) {
        case "existing": {
          projectName = await new Promise((resolve) => {
            const { unmount } = render(
              <>
                <Text>Select a project:</Text>
                <SelectInput
                  items={projects.map((project) => ({
                    key: project.name,
                    label: project.name,
                    value: project,
                  }))}
                  onSelect={async (selected) => {
                    resolve(selected.value.name);
                    unmount();
                  }}
                />
              </>
            );
          });
          break;
        }
        case "new": {
          projectName = await prompt("Enter the name of your new project:");

          if (!projectName) {
            throw new FatalError("Must specify a project name.", 1);
          }

          let isGitDir = true;
          try {
            execSync(`git rev-parse --is-inside-work-tree`, {
              stdio: "ignore",
            });
          } catch (err) {
            isGitDir = false;
          }

          const productionBranch = await prompt(
            "Enter the production branch name:",
            "text",
            isGitDir
              ? execSync(`git rev-parse --abbrev-ref HEAD`).toString().trim()
              : "production"
          );

          if (!productionBranch) {
            throw new FatalError("Must specify a production branch.", 1);
          }

          await fetchResult<Project>(`/accounts/${accountId}/pages/projects`, {
            method: "POST",
            body: JSON.stringify({
              name: projectName,
              production_branch: productionBranch,
            }),
          });

          saveToConfigCache<PagesConfigCache>(PAGES_CONFIG_CACHE_FILENAME, {
            account_id: accountId,
            project_name: projectName,
          });

          logger.log(`✨ Successfully created the '${projectName}' project.`);
          break;
        }
      }
    }

    if (!projectName) {
      throw new FatalError("Must specify a project name.", 1);
    }

    // We infer git info by default is not passed in

    let isGitDir = true;
    try {
      execSync(`git rev-parse --is-inside-work-tree`, {
        stdio: "ignore",
      });
    } catch (err) {
      isGitDir = false;
    }

    let isGitDirty = false;

    if (isGitDir) {
      try {
        isGitDirty = Boolean(
          execSync(`git status --porcelain`).toString().length
        );

        if (!branch) {
          branch = execSync(`git rev-parse --abbrev-ref HEAD`)
            .toString()
            .trim();
        }

        if (!commitHash) {
          commitHash = execSync(`git rev-parse HEAD`).toString().trim();
        }

        if (!commitMessage) {
          commitMessage = execSync(`git show -s --format=%B ${commitHash}`)
            .toString()
            .trim();
        }
      } catch (err) {}

      if (isGitDirty && !commitDirty) {
        logger.warn(
          `Warning: Your working directory is a git repo and has uncommitted changes\nTo silence this warning, pass in --commit-dirty=true`
        );
      }

      if (commitDirty === undefined) {
        commitDirty = isGitDirty;
      }
    }

    let builtFunctions: string | undefined = undefined;
    const functionsDirectory = join(cwd(), "functions");
    if (existsSync(functionsDirectory)) {
      const outfile = join(tmpdir(), `./functionsWorker-${Math.random()}.js`);

      await new Promise((resolve) =>
        buildFunctions({
          outfile,
          functionsDirectory,
          onEnd: () => resolve(null),
          buildOutputDirectory: dirname(outfile),
        })
      );

      builtFunctions = readFileSync(outfile, "utf-8");
    }

    const manifest = await upload({ directory, accountId, projectName });

    const formData = new FormData();

    formData.append("manifest", JSON.stringify(manifest));

    if (branch) {
      formData.append("branch", branch);
    }

    if (commitMessage) {
      formData.append("commit_message", commitMessage);
    }

    if (commitHash) {
      formData.append("commit_hash", commitHash);
    }

    if (commitDirty !== undefined) {
      formData.append("commit_dirty", commitDirty);
    }

    let _headers: string | undefined,
      _redirects: string | undefined,
      _workerJS: string | undefined;

    try {
      _headers = readFileSync(join(directory, "_headers"), "utf-8");
    } catch {}

    try {
      _redirects = readFileSync(join(directory, "_redirects"), "utf-8");
    } catch {}

    try {
      _workerJS = readFileSync(join(directory, "_worker.js"), "utf-8");
    } catch {}

    if (_headers) {
      formData.append("_headers", new File([_headers], "_headers"));
    }

    if (_redirects) {
      formData.append("_redirects", new File([_redirects], "_redirects"));
    }

    if (builtFunctions) {
      formData.append("_worker.js", new File([builtFunctions], "_worker.js"));
    } else if (_workerJS) {
      formData.append("_worker.js", new File([_workerJS], "_worker.js"));
    }

    const deploymentResponse = await fetchResult<Deployment>(
      `/accounts/${accountId}/pages/projects/${projectName}/deployments`,
      {
        method: "POST",
        body: formData,
      }
    );

    saveToConfigCache<PagesConfigCache>(PAGES_CONFIG_CACHE_FILENAME, {
      account_id: accountId,
      project_name: projectName,
    });

    logger.log(
      `✨ Deployment complete! Take a peek over at ${deploymentResponse.url}`
    );
  },
};

export const pages: BuilderCallback<unknown, unknown> = (yargs) => {
  return yargs
    .command(
      "dev [directory] [-- command..]",
      "🧑‍💻 Develop your full-stack Pages application locally",
      (yargs) => {
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
              description:
                "The port to proxy (where the static assets are served)",
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
            "node-compat": {
              describe: "Enable node.js compatibility",
              default: false,
              type: "boolean",
              hidden: true,
            },
            // TODO: Miniflare user options
          })
          .epilogue(pagesBetaWarning);
      },
      async ({
        local,
        directory,
        port,
        proxy: requestedProxyPort,
        "script-path": singleWorkerScriptPath,
        binding: bindings = [],
        kv: kvBindings = [],
        do: durableObjectBindings = [],
        "live-reload": liveReload,
        "node-compat": nodeCompat,
        _: [_pages, _dev, ...remaining],
      }) => {
        // Beta message for `wrangler pages <commands>` usage
        logger.log(pagesBetaWarning);

        if (!local) {
          logger.error("Only local mode is supported at the moment.");
          return;
        }

        const functionsDirectory = "./functions";
        const usingFunctions = existsSync(functionsDirectory);

        const command = remaining as (string | number)[];

        let proxyPort: number | void;

        if (directory === undefined) {
          proxyPort = await spawnProxyProcess({
            port: requestedProxyPort,
            command,
          });
          if (proxyPort === undefined) return undefined;
        }

        let miniflareArgs: MiniflareOptions = {};

        let scriptReadyResolve: () => void;
        const scriptReadyPromise = new Promise<void>(
          (resolve) => (scriptReadyResolve = resolve)
        );

        if (usingFunctions) {
          const outfile = join(
            tmpdir(),
            `./functionsWorker-${Math.random()}.js`
          );

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
          });

          miniflareArgs = {
            scriptPath: outfile,
          };
        } else {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          scriptReadyResolve!();

          const scriptPath =
            directory !== undefined
              ? join(directory, singleWorkerScriptPath)
              : singleWorkerScriptPath;

          if (existsSync(scriptPath)) {
            miniflareArgs = {
              scriptPath,
            };
          } else {
            logger.log("No functions. Shimming...");
            miniflareArgs = {
              // cfFetch sets the `cf` object that a function could expect
              // If there are no functions, there's no reason to set this up (and not make that network call)
              cfFetch: false,
              // TODO: The fact that these request/response hacks are necessary is ridiculous.
              // We need to eliminate them from env.ASSETS.fetch (not sure if just local or prod as well)
              script: `
            export default {
              async fetch(request, env, context) {
                const response = await env.ASSETS.fetch(request.url, request)
                return new Response(response.body, response)
              }
            }`,
            };
          }
        }

        // Defer importing miniflare until we really need it
        const { Miniflare, Log, LogLevel } = await import("miniflare");
        const { Response, fetch } = await import("@miniflare/core");

        // Wait for esbuild to finish building before starting Miniflare.
        // This must be before the call to `new Miniflare`, as that will
        // asynchronously start loading the script. `await startServer()`
        // internally just waits for that promise to resolve.
        await scriptReadyPromise;

        // `assetsFetch()` will only be called if there is `proxyPort` defined.
        // We only define `proxyPort`, above, when there is no `directory` defined.
        const assetsFetch =
          directory !== undefined
            ? await generateAssetsFetch(directory)
            : invalidAssetsFetch;

        const requestContextCheckOptions =
          await getRequestContextCheckOptions();

        const scriptNames = durableObjectBindings
          .map(
            (durableObjectBinding) =>
              DURABLE_OBJECTS_BINDING_REGEXP.exec(
                durableObjectBinding.toString()
              )?.groups?.scriptName
          )
          .filter(Boolean);
        const mounts = Object.fromEntries(
          scriptNames.map((scriptName) => [scriptName, scriptName])
        );
        const kvNamespaces = kvBindings.map((kvBinding) =>
          kvBinding.toString()
        );
        const durableObjects = Object.fromEntries(
          durableObjectBindings.map((durableObjectBinding) => {
            const groups = DURABLE_OBJECTS_BINDING_REGEXP.exec(
              durableObjectBinding.toString()
            )?.groups;
            return [
              groups?.binding,
              { className: groups?.className, scriptName: groups?.scriptName },
            ];
          })
        );

        if (Object.keys(durableObjects).length > 0) {
          console.log(
            "Caution! The interface for setting Durable Objects is current under active deployment. It is liable to change at any time."
          );
        }

        const miniflare = new Miniflare({
          port,
          watch: true,
          modules: true,

          log: new Log(LogLevel.ERROR, { prefix: "pages" }),
          logUnhandledRejections: true,
          sourceMap: true,

          mounts,
          kvNamespaces,
          durableObjects,

          // User bindings
          bindings: {
            ...Object.fromEntries(
              bindings
                .map((binding) => binding.toString().split("="))
                .map(([key, ...values]) => [key, values.join("=")])
            ),
          },

          // env.ASSETS.fetch
          serviceBindings: {
            async ASSETS(request: MiniflareRequest) {
              if (proxyPort) {
                try {
                  const url = new URL(request.url);
                  url.host = `localhost:${proxyPort}`;
                  return await fetch(url, request);
                } catch (thrown) {
                  logger.error(`Could not proxy request: ${thrown}`);

                  // TODO: Pretty error page
                  return new Response(
                    `[wrangler] Could not proxy request: ${thrown}`,
                    { status: 502 }
                  );
                }
              } else {
                try {
                  return await assetsFetch(request);
                } catch (thrown) {
                  logger.error(`Could not serve static asset: ${thrown}`);

                  // TODO: Pretty error page
                  return new Response(
                    `[wrangler] Could not serve static asset: ${thrown}`,
                    { status: 502 }
                  );
                }
              }
            },
          },

          kvPersist: true,
          durableObjectsPersist: true,
          cachePersist: true,
          liveReload,

          ...requestContextCheckOptions,
          ...miniflareArgs,
        });

        try {
          // `startServer` might throw if user code contains errors
          const server = await miniflare.startServer();
          logger.log(`Serving at http://localhost:${port}/`);

          if (process.env.BROWSER !== "none") {
            await openInBrowser(`http://localhost:${port}/`);
          }

          if (directory !== undefined && liveReload) {
            watch([directory], {
              persistent: true,
              ignoreInitial: true,
            }).on("all", async () => {
              await miniflare.reload();
            });
          }

          CLEANUP_CALLBACKS.push(() => {
            server.close();
            miniflare.dispose().catch((err) => miniflare.log.error(err));
          });
        } catch (e) {
          miniflare.log.error(e as Error);
          CLEANUP();
          throw new FatalError("Could not start Miniflare.", 1);
        }
      }
    )
    .command("functions", false, (yargs) =>
      // we hide this command from help output because
      // it's not meant to be used directly right now
      yargs.command(
        "build [directory]",
        "Compile a folder of Cloudflare Pages Functions into a single Worker",
        (yargs) =>
          yargs
            .positional("directory", {
              type: "string",
              default: "functions",
              description: "The directory of Pages Functions",
            })
            .options({
              outfile: {
                type: "string",
                default: "_worker.js",
                description: "The location of the output Worker script",
              },
              "output-config-path": {
                type: "string",
                description: "The location for the output config file",
              },
              minify: {
                type: "boolean",
                default: false,
                description: "Minify the output Worker script",
              },
              sourcemap: {
                type: "boolean",
                default: false,
                description:
                  "Generate a sourcemap for the output Worker script",
              },
              "fallback-service": {
                type: "string",
                default: "ASSETS",
                description:
                  "The service to fallback to at the end of the `next` chain. Setting to '' will fallback to the global `fetch`.",
              },
              watch: {
                type: "boolean",
                default: false,
                description:
                  "Watch for changes to the functions and automatically rebuild the Worker script",
              },
              plugin: {
                type: "boolean",
                default: false,
                description: "Build a plugin rather than a Worker script",
              },
              "build-output-directory": {
                type: "string",
                description: "The directory to output static assets to",
              },
              "node-compat": {
                describe: "Enable node.js compatibility",
                default: false,
                type: "boolean",
                hidden: true,
              },
            })
            .epilogue(pagesBetaWarning),
        async ({
          directory,
          outfile,
          "output-config-path": outputConfigPath,
          minify,
          sourcemap,
          fallbackService,
          watch,
          plugin,
          "build-output-directory": buildOutputDirectory,
          "node-compat": nodeCompat,
        }) => {
          if (!isInPagesCI) {
            // Beta message for `wrangler pages <commands>` usage
            logger.log(pagesBetaWarning);
          }

          if (nodeCompat) {
            console.warn(
              "Enabling node.js compatibility mode for builtins and globals. This is experimental and has serious tradeoffs. Please see https://github.com/ionic-team/rollup-plugin-node-polyfills/ for more details."
            );
          }

          buildOutputDirectory ??= dirname(outfile);

          await buildFunctions({
            outfile,
            outputConfigPath,
            functionsDirectory: directory,
            minify,
            sourcemap,
            fallbackService,
            watch,
            plugin,
            buildOutputDirectory,
            nodeCompat,
          });
        }
      )
    )
    .command("project", "⚡️ Interact with your Pages projects", (yargs) =>
      yargs
        .command(
          "list",
          "List your Cloudflare Pages projects",
          (yargs) => yargs.epilogue(pagesBetaWarning),
          async () => {
            const config = getConfigCache<PagesConfigCache>(
              PAGES_CONFIG_CACHE_FILENAME
            );

            const accountId = await requireAuth(config);

            const projects: Array<Project> = await listProjects({ accountId });

            const data = projects.map((project) => {
              return {
                "Project Name": project.name,
                "Project Domains": `${project.domains.join(", ")}`,
                "Git Provider": project.source ? "Yes" : "No",
                "Last Modified": project.latest_deployment
                  ? timeagoFormat(project.latest_deployment.modified_on)
                  : timeagoFormat(project.created_on),
              };
            });

            saveToConfigCache<PagesConfigCache>(PAGES_CONFIG_CACHE_FILENAME, {
              account_id: accountId,
            });

            render(<Table data={data}></Table>);
          }
        )
        .command(
          "create [project-name]",
          "Create a new Cloudflare Pages project",
          (yargs) =>
            yargs
              .positional("project-name", {
                type: "string",
                demandOption: true,
                description: "The name of your Pages project",
              })
              .options({
                "production-branch": {
                  type: "string",
                  description:
                    "The name of the production branch of your project",
                },
              })
              .epilogue(pagesBetaWarning),
          async ({ productionBranch, projectName }) => {
            const config = getConfigCache<PagesConfigCache>(
              PAGES_CONFIG_CACHE_FILENAME
            );
            const accountId = await requireAuth(config);

            const isInteractive = process.stdin.isTTY;
            if (!projectName && isInteractive) {
              projectName = await prompt("Enter the name of your new project:");
            }

            if (!projectName) {
              throw new FatalError("Must specify a project name.", 1);
            }

            if (!productionBranch && isInteractive) {
              let isGitDir = true;
              try {
                execSync(`git rev-parse --is-inside-work-tree`, {
                  stdio: "ignore",
                });
              } catch (err) {
                isGitDir = false;
              }

              productionBranch = await prompt(
                "Enter the production branch name:",
                "text",
                isGitDir
                  ? execSync(`git rev-parse --abbrev-ref HEAD`)
                      .toString()
                      .trim()
                  : "production"
              );
            }

            if (!productionBranch) {
              throw new FatalError("Must specify a production branch.", 1);
            }

            const { subdomain } = await fetchResult<Project>(
              `/accounts/${accountId}/pages/projects`,
              {
                method: "POST",
                body: JSON.stringify({
                  name: projectName,
                  production_branch: productionBranch,
                }),
              }
            );

            saveToConfigCache<PagesConfigCache>(PAGES_CONFIG_CACHE_FILENAME, {
              account_id: accountId,
              project_name: projectName,
            });

            logger.log(
              `✨ Successfully created the '${projectName}' project. It will be available at https://${subdomain}/ once you create your first deployment.`
            );
            logger.log(
              `To deploy a folder of assets, run 'wrangler pages publish [directory]'.`
            );
          }
        )
        .epilogue(pagesBetaWarning)
    )
    .command(
      "deployment",
      "🚀 Interact with the deployments of a project",
      (yargs) =>
        yargs
          .command(
            "list",
            "List deployments in your Cloudflare Pages project",
            (yargs) =>
              yargs
                .options({
                  "project-name": {
                    type: "string",
                    description:
                      "The name of the project you would like to list deployments for",
                  },
                })
                .epilogue(pagesBetaWarning),
            async ({ projectName }) => {
              const config = getConfigCache<PagesConfigCache>(
                PAGES_CONFIG_CACHE_FILENAME
              );
              const accountId = await requireAuth(config);

              projectName ??= config.project_name;

              const isInteractive = process.stdin.isTTY;
              if (!projectName && isInteractive) {
                const projects = await listProjects({ accountId });
                projectName = await new Promise((resolve) => {
                  const { unmount } = render(
                    <>
                      <Text>Select a project:</Text>
                      <SelectInput
                        items={projects.map((project) => ({
                          key: project.name,
                          label: project.name,
                          value: project,
                        }))}
                        onSelect={async (selected) => {
                          resolve(selected.value.name);
                          unmount();
                        }}
                      />
                    </>
                  );
                });
              }

              if (!projectName) {
                throw new FatalError("Must specify a project name.", 1);
              }

              const deployments: Array<Deployment> = await fetchResult(
                `/accounts/${accountId}/pages/projects/${projectName}/deployments`
              );

              const titleCase = (word: string) =>
                word.charAt(0).toUpperCase() + word.slice(1);

              const shortSha = (sha: string) => sha.slice(0, 7);

              const getStatus = (deployment: Deployment) => {
                // Return a pretty time since timestamp if successful otherwise the status
                if (deployment.latest_stage.status === `success`) {
                  return timeagoFormat(deployment.latest_stage.ended_on);
                }
                return titleCase(deployment.latest_stage.status);
              };

              const data = deployments.map((deployment) => {
                return {
                  Environment: titleCase(deployment.environment),
                  Branch: deployment.deployment_trigger.metadata.branch,
                  Source: shortSha(
                    deployment.deployment_trigger.metadata.commit_hash
                  ),
                  Deployment: deployment.url,
                  Status: getStatus(deployment),
                  // TODO: Use a url shortener
                  Build: `https://dash.cloudflare.com/${accountId}/pages/view/${deployment.project_name}/${deployment.id}`,
                };
              });

              saveToConfigCache<PagesConfigCache>(PAGES_CONFIG_CACHE_FILENAME, {
                account_id: accountId,
              });

              render(<Table data={data}></Table>);
            }
          )
          .command({
            command: "create [directory]",
            ...createDeployment,
          } as CommandModule)
          .epilogue(pagesBetaWarning)
    )
    .command({
      command: "publish [directory]",
      ...createDeployment,
    } as CommandModule);
};

const invalidAssetsFetch: typeof miniflareFetch = () => {
  throw new Error(
    "Trying to fetch assets directly when there is no `directory` option specified, and not in `local` mode."
  );
};

const listProjects = async ({
  accountId,
}: {
  accountId: string;
}): Promise<Array<Project>> => {
  const pageSize = 10;
  let page = 1;
  const results = [];
  while (results.length % pageSize === 0) {
    const json: Array<Project> = await fetchResult(
      `/accounts/${accountId}/pages/projects`,
      {},
      new URLSearchParams({
        per_page: pageSize.toString(),
        page: page.toString(),
      })
    );
    page++;
    results.push(...json);
    if (json.length < pageSize) {
      break;
    }
  }
  return results;
};

function formatTime(duration: number) {
  return `(${(duration / 1000).toFixed(2)} sec)`;
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <>
      <Text>
        <Spinner type="earth" />
        {` Uploading... (${done}/${total})\n`}
      </Text>
    </>
  );
}
