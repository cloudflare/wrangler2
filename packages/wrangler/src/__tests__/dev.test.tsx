import * as fs from "node:fs";
import getPort from "get-port";
import patchConsole from "patch-console";
import dedent from "ts-dedent";
import Dev from "../dev/dev";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import { setMockResponse, unsetAllMocks } from "./helpers/mock-cfetch";
import { mockConsoleMethods } from "./helpers/mock-console";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import writeWranglerToml from "./helpers/write-wrangler-toml";

describe("wrangler dev", () => {
  mockAccountId();
  mockApiToken();
  runInTempDir();
  const std = mockConsoleMethods();
  afterEach(() => {
    (Dev as jest.Mock).mockClear();
    patchConsole(() => {});
    unsetAllMocks();
  });

  describe("compatibility-date", () => {
    it("should not warn if there is no wrangler.toml and no compatibility-date specified", async () => {
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev index.js");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should warn if there is a wrangler.toml but no compatibility-date", async () => {
      writeWranglerToml({
        main: "index.js",
        compatibility_date: undefined,
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      const currentDate = new Date().toISOString().substring(0, 10);
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn.replaceAll(currentDate, "<current-date>"))
        .toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mNo compatibility_date was specified. Using today's date: <current-date>.[0m

          Add one to your wrangler.toml file:
          \`\`\`
          compatibility_date = \\"<current-date>\\"
          \`\`\`
          or pass it in your terminal:
          \`\`\`
          --compatibility-date=<current-date>
          \`\`\`
          See [4mhttps://developers.cloudflare.com/workers/platform/compatibility-dates[0m for more information.

        "
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should not warn if there is a wrangler.toml but compatibility-date is specified at the command line", async () => {
      writeWranglerToml({
        main: "index.js",
        compatibility_date: undefined,
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --compatibility-date=2020-01-01");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("entry-points", () => {
    it("should error if there is no entry-point specified", async () => {
      writeWranglerToml();

      await expect(
        runWrangler("dev")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Missing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler dev path/to/script\`) or the \`main\` config field."`
      );

      expect(std.out).toMatchInlineSnapshot(`
        "
        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new/choose[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mMissing entry-point: The entry-point should be specified via the command line (e.g. \`wrangler dev path/to/script\`) or the \`main\` config field.[0m

        "
      `);
    });

    it("should use `main` from the top-level environment", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].entry.file).toMatch(
        /index\.js$/
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `main` from a named environment", async () => {
      writeWranglerToml({
        env: {
          ENV1: {
            main: "index.js",
          },
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --env=ENV1");
      expect((Dev as jest.Mock).mock.calls[0][0].entry.file).toMatch(
        /index\.js$/
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `main` from a named environment, rather than the top-level", async () => {
      writeWranglerToml({
        main: "other.js",
        env: {
          ENV1: {
            main: "index.js",
          },
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --env=ENV1");
      expect((Dev as jest.Mock).mock.calls[0][0].entry.file).toMatch(
        /index\.js$/
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("host", () => {
    it("should resolve a host to its zone", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev --host some-host.com");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "some-host.com",
        id: "some-zone-id",
      });
    });

    it("should read wrangler.toml's dev.host", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          host: "some-host.com",
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should read --route", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev --route http://some-host.com/some/path/*");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should read wrangler.toml's routes", async () => {
      writeWranglerToml({
        main: "index.js",
        routes: [
          "http://some-host.com/some/path/*",
          "http://some-other-host.com/path/*",
        ],
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should read wrangler.toml's environment specific routes", async () => {
      writeWranglerToml({
        main: "index.js",
        routes: [
          "http://a-host.com/some/path/*",
          "http://another-host.com/path/*",
        ],
        env: {
          staging: {
            routes: [
              "http://some-host.com/some/path/*",
              "http://some-other-host.com/path/*",
            ],
          },
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev --env staging");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should strip leading `*` from given host when deducing a zone id", async () => {
      writeWranglerToml({
        main: "index.js",
        route: "*some-host.com/some/path/*",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should strip leading `*.` from given host when deducing a zone id", async () => {
      writeWranglerToml({
        main: "index.js",
        route: "*.some-host.com/some/path/*",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone.host).toEqual(
        "some-host.com"
      );
    });

    it("should, when provided, use a configured zone_id", async () => {
      writeWranglerToml({
        main: "index.js",
        routes: [
          { pattern: "https://some-domain.com/*", zone_id: "some-zone-id" },
        ],
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "some-domain.com",
        id: "some-zone-id",
      });
    });

    it("should, when provided, use a zone_name to get a zone_id", async () => {
      writeWranglerToml({
        main: "index.js",
        routes: [
          { pattern: "https://some-domain.com/*", zone_name: "some-zone.com" },
        ],
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-zone.com", [{ id: "a-zone-id" }]);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        // note that it uses the provided zone_name as a host too
        host: "some-zone.com",
        id: "a-zone-id",
      });
    });

    it("given a long host, it should use the longest subdomain that resolves to a zone", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("111.222.333.some-host.com", []);
      mockGetZones("222.333.some-host.com", []);
      mockGetZones("333.some-host.com", [{ id: "some-zone-id" }]);
      await runWrangler("dev --host 111.222.333.some-host.com");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "111.222.333.some-host.com",
        id: "some-zone-id",
      });
    });

    it("should, in order, use args.host/config.dev.host/args.routes/(config.route|config.routes)", async () => {
      // This test might seem like it's testing implementation details, but let's be specific and consider it a spec

      fs.writeFileSync("index.js", `export default {};`);

      // config.routes
      mockGetZones("5.some-host.com", [{ id: "some-zone-id-5" }]);
      writeWranglerToml({
        main: "index.js",
        routes: ["http://5.some-host.com/some/path/*"],
      });
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "5.some-host.com",
        id: "some-zone-id-5",
      });
      (Dev as jest.Mock).mockClear();

      // config.route
      mockGetZones("4.some-host.com", [{ id: "some-zone-id-4" }]);
      writeWranglerToml({
        main: "index.js",
        route: "https://4.some-host.com/some/path/*",
      });
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "4.some-host.com",
        id: "some-zone-id-4",
      });
      (Dev as jest.Mock).mockClear();

      // --routes
      mockGetZones("3.some-host.com", [{ id: "some-zone-id-3" }]);
      writeWranglerToml({
        main: "index.js",
        route: "https://4.some-host.com/some/path/*",
      });
      await runWrangler("dev --routes http://3.some-host.com/some/path/*");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "3.some-host.com",
        id: "some-zone-id-3",
      });
      (Dev as jest.Mock).mockClear();

      // config.dev.host
      mockGetZones("2.some-host.com", [{ id: "some-zone-id-2" }]);
      writeWranglerToml({
        main: "index.js",
        dev: {
          host: `2.some-host.com`,
        },
        route: "4.some-host.com/some/path/*",
      });
      await runWrangler("dev --routes http://3.some-host.com/some/path/*");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "2.some-host.com",
        id: "some-zone-id-2",
      });
      (Dev as jest.Mock).mockClear();

      // --host
      mockGetZones("1.some-host.com", [{ id: "some-zone-id-1" }]);
      writeWranglerToml({
        main: "index.js",
        dev: {
          host: `2.some-host.com`,
        },
        route: "4.some-host.com/some/path/*",
      });
      await runWrangler(
        "dev --routes http://3.some-host.com/some/path/* --host 1.some-host.com"
      );
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual({
        host: "1.some-host.com",
        id: "some-zone-id-1",
      });
      (Dev as jest.Mock).mockClear();
    });

    it("should error if a host can't resolve to a zone", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      mockGetZones("some-host.com", []);
      await expect(
        runWrangler("dev --host some-host.com")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Could not find zone for some-host.com"`
      );
    });

    it("should not try to resolve a zone when starting in local mode", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --host some-host.com --local");
      expect((Dev as jest.Mock).mock.calls[0][0].zone).toEqual(undefined);
    });
  });

  describe("custom builds", () => {
    it("should run a custom build before starting `dev`", async () => {
      writeWranglerToml({
        build: {
          command: `node -e "console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')"`,
        },
      });

      await runWrangler("dev index.js");

      expect(fs.readFileSync("index.js", "utf-8")).toMatchInlineSnapshot(
        `"export default { fetch(){ return new Response(123) } }"`
      );

      // and the command would pass through
      expect((Dev as jest.Mock).mock.calls[0][0].build).toEqual({
        command:
          "node -e \"console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')\"",
        cwd: undefined,
        watch_dir: "src",
      });
      expect(std.out).toMatchInlineSnapshot(
        `"Running custom build: node -e \\"console.log('custom build'); require('fs').writeFileSync('index.js', 'export default { fetch(){ return new Response(123) } }')\\""`
      );
      expect(std.err).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });

    if (process.platform !== "win32") {
      it("should run a custom build of multiple steps combined by && before starting `dev`", async () => {
        writeWranglerToml({
          build: {
            command: `echo "custom build" && echo "export default { fetch(){ return new Response(123) } }" > index.js`,
          },
        });

        await runWrangler("dev index.js");

        expect(fs.readFileSync("index.js", "utf-8")).toMatchInlineSnapshot(`
          "export default { fetch(){ return new Response(123) } }
          "
        `);

        expect(std.out).toMatchInlineSnapshot(
          `"Running custom build: echo \\"custom build\\" && echo \\"export default { fetch(){ return new Response(123) } }\\" > index.js"`
        );
        expect(std.err).toMatchInlineSnapshot(`""`);
        expect(std.warn).toMatchInlineSnapshot(`""`);
      });
    }

    it("should throw an error if the entry doesn't exist after the build finishes", async () => {
      writeWranglerToml({
        main: "index.js",
        build: {
          command: `node -e "console.log('custom build');"`,
        },
      });

      await expect(runWrangler("dev")).rejects
        .toThrowErrorMatchingInlineSnapshot(`
              "The expected output file at \\"index.js\\" was not found after running custom build: node -e \\"console.log('custom build');\\".
              The \`main\` property in wrangler.toml should point to the file generated by the custom build."
            `);
      expect(std.out).toMatchInlineSnapshot(`
        "Running custom build: node -e \\"console.log('custom build');\\"

        [32mIf you think this is a bug then please create an issue at https://github.com/cloudflare/wrangler2/issues/new/choose[0m"
      `);
      expect(std.err).toMatchInlineSnapshot(`
        "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe expected output file at \\"index.js\\" was not found after running custom build: node -e \\"console.log('custom build');\\".[0m

          The \`main\` property in wrangler.toml should point to the file generated by the custom build.

        "
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
    });
  });

  describe("upstream-protocol", () => {
    it("should default upstream-protocol to `https`", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].upstreamProtocol).toEqual(
        "https"
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should warn if `--upstream-protocol=http` is used", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --upstream-protocol=http");
      expect((Dev as jest.Mock).mock.calls[0][0].upstreamProtocol).toEqual(
        "http"
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mSetting upstream-protocol to http is not currently implemented.[0m

          If this is required in your project, please add your use case to the following issue:
          [4mhttps://github.com/cloudflare/wrangler2/issues/583[0m.

        "
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("local-protocol", () => {
    it("should default local-protocol to `http`", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].localProtocol).toEqual("http");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use `local_protocol` from `wrangler.toml`, if available", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          local_protocol: "https",
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].localProtocol).toEqual(
        "https"
      );
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use --local-protocol command line arg, if provided", async () => {
      // Here we show that the command line overrides the wrangler.toml by
      // setting the config to https, and then setting it back to http on the command line.
      writeWranglerToml({
        main: "index.js",
        dev: {
          local_protocol: "https",
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --local-protocol=http");
      expect((Dev as jest.Mock).mock.calls[0][0].localProtocol).toEqual("http");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("ip", () => {
    it("should default ip to localhost", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].ip).toEqual("localhost");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use to `ip` from `wrangler.toml`, if available", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          ip: "0.0.0.0",
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].ip).toEqual("0.0.0.0");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use --ip command line arg, if provided", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          ip: "1.1.1.1",
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev --ip=0.0.0.0");
      expect((Dev as jest.Mock).mock.calls[0][0].ip).toEqual("0.0.0.0");
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("port", () => {
    it("should default port to 8787 if it is not in use", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].port).toEqual(8787);
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use to `port` from `wrangler.toml`, if available", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          port: 8888,
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      // Mock `getPort()` to resolve to a completely different port.
      (getPort as jest.Mock).mockResolvedValue(98765);

      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].port).toEqual(8888);
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use --port command line arg, if provided", async () => {
      writeWranglerToml({
        main: "index.js",
        dev: {
          port: 8888,
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      // Mock `getPort()` to resolve to a completely different port.
      (getPort as jest.Mock).mockResolvedValue(98765);

      await runWrangler("dev --port=9999");
      expect((Dev as jest.Mock).mock.calls[0][0].port).toEqual(9999);
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should use a different port to the default if it is in use", async () => {
      writeWranglerToml({
        main: "index.js",
      });
      fs.writeFileSync("index.js", `export default {};`);
      // Mock `getPort()` to resolve to a completely different port.
      (getPort as jest.Mock).mockResolvedValue(98765);

      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].port).toEqual(98765);
      expect(std.out).toMatchInlineSnapshot(`""`);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("durable_objects", () => {
    it("should warn if there are remote Durable Objects, or missing migrations for local Durable Objects", async () => {
      writeWranglerToml({
        main: "index.js",
        durable_objects: {
          bindings: [
            { name: "NAME_1", class_name: "CLASS_1" },
            {
              name: "NAME_2",
              class_name: "CLASS_2",
              script_name: "SCRIPT_A",
            },
            { name: "NAME_3", class_name: "CLASS_3" },
            {
              name: "NAME_4",
              class_name: "CLASS_4",
              script_name: "SCRIPT_B",
            },
          ],
        },
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev");
      expect((Dev as jest.Mock).mock.calls[0][0].ip).toEqual("localhost");
      expect(std.out).toMatchInlineSnapshot(`
        "Your worker has access to the following bindings:
        - Durable Objects:
          - NAME_1: CLASS_1
          - NAME_2: CLASS_2 (defined in SCRIPT_A)
          - NAME_3: CLASS_3
          - NAME_4: CLASS_4 (defined in SCRIPT_B)"
      `);
      expect(std.warn).toMatchInlineSnapshot(`
        "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:[0m

            - In wrangler.toml, you have configured [durable_objects] exported by this Worker (CLASS_1,
          CLASS_3), but no [migrations] for them. This may not work as expected until you add a [migrations]
          section to your wrangler.toml. Add this configuration to your wrangler.toml:

                \`\`\`
                [[migrations]]
                tag = \\"v1\\" # Should be unique for each entry
                new_classes = [\\"CLASS_1\\", \\"CLASS_3\\"]
                \`\`\`

              Refer to
          [4mhttps://developers.cloudflare.com/workers/learning/using-durable-objects/#durable-object-migrations-in-wranglertoml[0m
          for more details.


        [33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mWARNING: You have Durable Object bindings that are not defined locally in the worker being developed.[0m

          Be aware that changes to the data stored in these Durable Objects will be permanent and affect the
          live instances.
          Remote Durable Objects that are affected:
          - {\\"name\\":\\"NAME_2\\",\\"class_name\\":\\"CLASS_2\\",\\"script_name\\":\\"SCRIPT_A\\"}
          - {\\"name\\":\\"NAME_4\\",\\"class_name\\":\\"CLASS_4\\",\\"script_name\\":\\"SCRIPT_B\\"}

        "
      `);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });

    it("should apply migrations for durable objects", async () => {
      writeWranglerToml({
        durable_objects: {
          bindings: [
            { name: "SOMENAME", class_name: "SomeClass" },
            { name: "SOMEOTHERNAME", class_name: "SomeOtherClass" },
          ],
        },
        migrations: [
          { tag: "v1", new_classes: ["SomeClass"] },
          { tag: "v2", new_classes: ["SomeOtherClass"] },
        ],
      });
      fs.writeFileSync(
        "index.js",
        `export class SomeClass{}; export class SomeOtherClass{}; export default {};`
      );

      mockLegacyScriptData({ scripts: [] }); // no previously uploaded scripts at all

      await runWrangler("dev index.js");
      expect((Dev as jest.Mock).mock.calls[0][0].migrations)
        .toMatchInlineSnapshot(`
        Object {
          "new_tag": "v2",
          "steps": Array [
            Object {
              "new_classes": Array [
                "SomeClass",
              ],
            },
            Object {
              "new_classes": Array [
                "SomeOtherClass",
              ],
            },
          ],
        }
      `);
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Your worker has access to the following bindings:
        - Durable Objects:
          - SOMENAME: SomeClass
          - SOMEOTHERNAME: SomeOtherClass",
          "warn": "",
        }
      `);
    });
  });

  describe(".dev.vars", () => {
    it("should override `vars` bindings from `wrangler.toml` with values in `.dev.vars`", async () => {
      fs.writeFileSync("index.js", `export default {};`);

      const localVarsEnvContent = dedent`
      # Preceding comment
      VAR_1="var #1 value" # End of line comment
      VAR_3="var #3 value"
      VAR_MULTI_LINE_1="A: line 1
      line 2"
      VAR_MULTI_LINE_2="B: line 1\\nline 2"
      EMPTY=
      UNQUOTED= unquoted value
      `;
      fs.writeFileSync(".dev.vars", localVarsEnvContent, "utf8");

      writeWranglerToml({
        main: "index.js",
        vars: {
          VAR_1: "original value 1",
          VAR_2: "original value 2", // should not get overridden
          VAR_3: "original value 3",
          VAR_MULTI_LINE_1: "original multi-line 1",
          VAR_MULTI_LINE_2: "original multi-line 2",
          EMPTY: "original empty",
          UNQUOTED: "original unquoted",
        },
      });
      await runWrangler("dev");
      const varBindings: Record<string, unknown> = (Dev as jest.Mock).mock
        .calls[0][0].bindings.vars;

      expect(varBindings).toEqual({
        VAR_1: "var #1 value",
        VAR_2: "original value 2",
        VAR_3: "var #3 value",
        VAR_MULTI_LINE_1: "A: line 1\nline 2",
        VAR_MULTI_LINE_2: "B: line 1\nline 2",
        EMPTY: "",
        UNQUOTED: "unquoted value", // Note that whitespace is trimmed
      });
      expect(std.out).toMatchInlineSnapshot(`
        "Using vars defined in .dev.vars
        Your worker has access to the following bindings:
        - Vars:
          - VAR_1: \\"(hidden)\\"
          - VAR_2: \\"original value 2\\"
          - VAR_3: \\"(hidden)\\"
          - VAR_MULTI_LINE_1: \\"(hidden)\\"
          - VAR_MULTI_LINE_2: \\"(hidden)\\"
          - EMPTY: \\"(hidden)\\"
          - UNQUOTED: \\"(hidden)\\""
      `);
      expect(std.warn).toMatchInlineSnapshot(`""`);
      expect(std.err).toMatchInlineSnapshot(`""`);
    });
  });

  describe("site", () => {
    it("should error if --site is used with no value", async () => {
      await expect(
        runWrangler("dev --site")
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `"Not enough arguments following: site"`
      );

      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mNot enough arguments following: site[0m

        ",
          "out": "
        wrangler dev [script]

        👂 Start a local server for developing your worker

        Positionals:
          script  The path to an entry point for your worker  [string]

        Flags:
          -c, --config   Path to .toml configuration file  [string]
          -h, --help     Show help  [boolean]
          -v, --version  Show version number  [boolean]

        Options:
              --name                                       Name of the worker  [string]
              --format                                     Choose an entry type  [deprecated] [choices: \\"modules\\", \\"service-worker\\"]
          -e, --env                                        Perform on a specific environment  [string]
              --compatibility-date                         Date to use for compatibility checks  [string]
              --compatibility-flags, --compatibility-flag  Flags to use for compatibility checks  [array]
              --latest                                     Use the latest version of the worker runtime  [boolean] [default: true]
              --ip                                         IP address to listen on, defaults to \`localhost\`  [string]
              --port                                       Port to listen on  [number]
              --inspector-port                             Port for devtools to connect to  [number]
              --routes, --route                            Routes to upload  [array]
              --host                                       Host to forward requests to, defaults to the zone of project  [string]
              --local-protocol                             Protocol to listen to requests on, defaults to http.  [choices: \\"http\\", \\"https\\"]
              --experimental-public                        Static assets to be served  [string]
              --site                                       Root folder of static assets for Workers Sites  [string]
              --site-include                               Array of .gitignore-style patterns that match file or directory names from the sites directory. Only matched items will be uploaded.  [array]
              --site-exclude                               Array of .gitignore-style patterns that match file or directory names from the sites directory. Matched items will not be uploaded.  [array]
              --upstream-protocol                          Protocol to forward requests to host on, defaults to https.  [choices: \\"http\\", \\"https\\"]
              --jsx-factory                                The function that is called for each JSX element  [string]
              --jsx-fragment                               The function that is called for each JSX fragment  [string]
              --tsconfig                                   Path to a custom tsconfig.json file  [string]
          -l, --local                                      Run on my machine  [boolean] [default: false]
              --minify                                     Minify the script  [boolean]
              --node-compat                                Enable node.js compatibility  [boolean]
              --experimental-enable-local-persistence      Enable persistence for this session (only for local mode)  [boolean]
              --inspect                                    Enable dev tools  [deprecated] [boolean]",
          "warn": "",
        }
      `);
    });
  });

  describe("--inspect", () => {
    it("should warn if --inspect is used", async () => {
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev index.js --inspect");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mPassing --inspect is unnecessary, now you can always connect to devtools.[0m

        ",
        }
      `);
    });
  });

  describe("service bindings", () => {
    it("should warn when using service bindings", async () => {
      writeWranglerToml({
        services: [
          { binding: "WorkerA", service: "A" },
          { binding: "WorkerB", service: "B", environment: "staging" },
        ],
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev index.js");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Your worker has access to the following bindings:
        - Services:
          - WorkerA: A
          - WorkerB: B - staging",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:[0m

            - \\"services\\" fields are experimental and may change or break at any time.


        [33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThis worker is bound to live services: WorkerA (A), WorkerB (B@staging)[0m

        ",
        }
      `);
    });
  });

  describe("print bindings", () => {
    it("should print bindings", async () => {
      writeWranglerToml({
        services: [
          { binding: "WorkerA", service: "A" },
          { binding: "WorkerB", service: "B", environment: "staging" },
        ],
      });
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev index.js");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Your worker has access to the following bindings:
        - Services:
          - WorkerA: A
          - WorkerB: B - staging",
          "warn": "[33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mProcessing wrangler.toml configuration:[0m

            - \\"services\\" fields are experimental and may change or break at any time.


        [33m▲ [43;33m[[43;30mWARNING[43;33m][0m [1mThis worker is bound to live services: WorkerA (A), WorkerB (B@staging)[0m

        ",
        }
      `);
    });

    it("should mask vars that were overriden in .dev.vars", async () => {
      writeWranglerToml({
        vars: {
          variable: 123,
          overriden: "original values",
        },
      });
      fs.writeFileSync(
        ".dev.vars",
        `
        SECRET = "A secret"
        overriden = "overriden value"
      `
      );
      fs.writeFileSync("index.js", `export default {};`);
      await runWrangler("dev index.js");
      expect(std).toMatchInlineSnapshot(`
        Object {
          "debug": "",
          "err": "",
          "out": "Using vars defined in .dev.vars
        Your worker has access to the following bindings:
        - Vars:
          - variable: \\"123\\"
          - overriden: \\"(hidden)\\"
          - SECRET: \\"(hidden)\\"",
          "warn": "",
        }
      `);
    });
  });
});

function mockGetZones(domain: string, zones: { id: string }[] = []) {
  const removeMock = setMockResponse(
    "/zones",
    "GET",
    (_urlPieces, _init, queryParams) => {
      expect([...queryParams.entries()]).toEqual([["name", domain]]);
      // Because the API URL `/zones` is the same for each request, we can get into a situation where earlier mocks get triggered for later requests. So, we simply clear the mock on every trigger.
      removeMock();
      return zones;
    }
  );
}

// copied from publish.test.ts
type LegacyScriptInfo = { id: string; migration_tag?: string };

function mockLegacyScriptData(options: { scripts: LegacyScriptInfo[] }) {
  const { scripts } = options;
  setMockResponse(
    "/accounts/:accountId/workers/scripts",
    "GET",
    ([_url, accountId]) => {
      expect(accountId).toEqual("some-account-id");
      return scripts;
    }
  );
}
