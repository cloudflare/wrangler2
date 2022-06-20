/* eslint-disable no-shadow */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, sep } from "node:path";
import { cwd } from "node:process";
import { hash } from "blake3-wasm";
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
import { fetchResult } from "../cfetch";
import { getConfigCache, saveToConfigCache } from "../config-cache";
import { prompt } from "../dialogs";
import { FatalError } from "../errors";
import { logger } from "../logger";
import { requireAuth } from "../user";
import { PagesBuildHandler, PagesBuildOptions } from "./build";
import {
  BULK_UPLOAD_CONCURRENCY,
  MAX_BUCKET_FILE_COUNT,
  MAX_BUCKET_SIZE,
  MAX_UPLOAD_ATTEMPTS,
  PAGES_CONFIG_CACHE_FILENAME,
} from "./constants";
import * as PagesDev from "./dev";
import { buildFunctions, CLEANUP, pagesBetaWarning } from "./utils";
import type {
  Deployment,
  PagesConfigCache,
  Project,
  UploadPayloadFile,
} from "./types";
import type { BuilderCallback, CommandModule } from "yargs";

process.on("SIGINT", () => {
  CLEANUP();
  process.exit();
});
process.on("SIGTERM", () => {
  CLEANUP();
  process.exit();
});

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
      PagesDev.options,
      PagesDev.handler
    )
    .command("functions", false, (yargs) =>
      // we hide this command from help output because
      // it's not meant to be used directly right now
      {
        return yargs.command(
          "build [directory]",
          "Compile a folder of Cloudflare Pages Functions into a single Worker",
          PagesBuildOptions,
          PagesBuildHandler
        );
      }
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
    } as CommandModule)
    .epilogue(pagesBetaWarning);
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
