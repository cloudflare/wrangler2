import { spawn } from "child_process";
import * as path from "path";
import { fetch } from "undici";
import type { ChildProcess } from "child_process";
import type { Response, RequestInit } from "undici";

const waitUntilReady = async (url: string, init?: RequestInit): Promise<Response> => {
  let response: Response | undefined = undefined;

  while (response === undefined) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

    try {
      response = await fetch(url, init);
    } catch {}
  }

  return response as Response;
};

const isWindows = process.platform === "win32";

describe("Pages Functions", () => {
  let wranglerProcess: ChildProcess;

  beforeEach(() => {
    wranglerProcess = spawn("npm", ["run", "dev"], {
      shell: isWindows,
      cwd: path.resolve(__dirname, "../"),
      env: { BROWSER: "none", ...process.env },
    });
    wranglerProcess.stdout?.on("data", (chunk) => {
      console.log(chunk.toString());
    });
    wranglerProcess.stderr?.on("data", (chunk) => {
      console.log(chunk.toString());
    });
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => {
      wranglerProcess.once("exit", (code) => {
        if (!code) {
          resolve(code);
        } else {
          reject(code);
        }
      });
      wranglerProcess.kill("SIGTERM");
    });
  });

  it("renders static pages", async () => {
    const response = await waitUntilReady("http://localhost:8789/");
    expect(response.headers.get("x-custom")).toBe("header value");
    const text = await response.text();
    expect(text).toContain("Hello, world!");
  });

  it("passes environment variables", async () => {
    const response = await waitUntilReady("http://localhost:8789/variables");
    const env = await response.json();
    expect(env).toEqual({
      ASSETS: {},
      NAME: "VALUE",
      OTHER_NAME: "THING=WITH=EQUALS",
      VAR_1: "var #1 value",
      VAR_3: "var #3 value",
      VAR_MULTI_LINE_1: "A: line 1\nline 2",
      VAR_MULTI_LINE_2: "B: line 1\nline 2",
      EMPTY: "",
      UNQUOTED: "unquoted value", // Note that whitespace is trimmed
    });
  });

  it("intercepts static requests with next()", async () => {
    const response = await waitUntilReady("http://localhost:8789/intercept");
    const text = await response.text();
    expect(text).toContain("Hello, world!");
    expect(response.headers.get("x-set-from-functions")).toBe("true");
  });

  it("accepts one query param redirects", async () => {
    const response = await waitUntilReady("http://localhost:8789/blog?year=2022", {
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    expect(location).toBe("/blog/2022?year=2022")
  });

  it("accepts multiple query param redirects", async () => {
    const response = await waitUntilReady("http://localhost:8789/news?author=Skye&year=2022", {
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    expect(location).toBe("/blog/2022/Skye?author=Skye&year=2022")
  });

  it("accepts out of order query params to redirect", async () => {
    const response = await waitUntilReady("http://localhost:8789/sort-params?b=2&a=1", {
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    expect(location).toBe("/sorted-params?b=2&a=1")
  });

  it("ignores irrelevant params", async () => {
    const response = await waitUntilReady("http://localhost:8789/irrelevant?a=1&b=2", {
      redirect: 'manual',
    });
    const location = response.headers.get('location');
    expect(location).toBe("/relevant?a=1&b=2")
  });


  it("can make SSR responses", async () => {
    const response = await waitUntilReady("http://localhost:8789/date");
    const text = await response.text();
    expect(text).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  });

  it("can use parameters", async () => {
    const response = await waitUntilReady(
      "http://localhost:8789/blog/hello-world"
    );
    const text = await response.text();
    expect(text).toContain("<h1>A blog with a slug: hello-world</h1>");
  });

  it("can override the incoming request with next() parameters", async () => {
    const response = await waitUntilReady("http://localhost:8789/next");
    const text = await response.text();
    expect(text).toContain("<h1>An asset</h1>");
  });

  describe("can mount a plugin", () => {
    it("should mount Middleware", async () => {
      const response = await waitUntilReady(
        "http://localhost:8789/mounted-plugin/some-page"
      );
      const text = await response.text();
      expect(text).toContain("<footer>Set from a Plugin!</footer>");
    });

    it("should mount Fixed page", async () => {
      const response = await waitUntilReady(
        "http://localhost:8789/mounted-plugin/fixed"
      );
      const text = await response.text();
      expect(text).toContain("I'm a fixed response");
    });
  });

  describe("can import static assets", () => {
    it("should render a static asset", async () => {
      const response = await waitUntilReady("http://localhost:8789/static");
      const text = await response.text();
      expect(text).toContain("<h1>Hello from an imported static asset!</h1>");
    });

    it("should render from a Plugin", async () => {
      const response = await waitUntilReady(
        "http://localhost:8789/mounted-plugin/static"
      );
      const text = await response.text();
      expect(text).toContain(
        "<h1>Hello from a static asset brought from a Plugin!</h1>"
      );
    });

    it("should render static/foo", async () => {
      const response = await waitUntilReady(
        "http://localhost:8789/mounted-plugin/static/foo"
      );
      const text = await response.text();
      expect(text).toContain("<h1>foo</h1>");
    });

    it("should render static/dir/bar", async () => {
      const response = await waitUntilReady(
        "http://localhost:8789/mounted-plugin/static/dir/bar"
      );
      const text = await response.text();
      expect(text).toContain("<h1>bar</h1>");
    });
  });
});
