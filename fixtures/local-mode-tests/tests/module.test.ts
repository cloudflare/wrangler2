import wrangler from "wrangler";

describe("worker", () => {
	let worker: {
		fetch: (init?: RequestInit) => Promise<Response>;
		stop: () => Promise<void>;
	};

	beforeAll(async () => {
		//since the script is invoked from the directory above, need to specify index.js is in src/
		worker = await wrangler.unstable_dev("src/module.ts", {
			config: "src/wrangler.module.toml",
		});
	});

	afterAll(async () => {
		await worker.stop();
	});

	it("renders", async () => {
		const resp = await worker.fetch();
		expect(resp).not.toBe(undefined);

		const text = await resp.text();
		expect(text).toMatchInlineSnapshot(`
    "{
      \\"VAR1\\": \\"value1\\",
      \\"VAR2\\": 123,
      \\"VAR3\\": {
        \\"abc\\": \\"def\\"
      },
      \\"text\\": \\"Here be some text\\",
      \\"data\\": \\"Here be some data\\"
    }"
  `);
	});
});
