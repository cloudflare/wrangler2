import wrangler from "wrangler";

describe("worker", () => {
	let worker: {
		fetch: (init?: RequestInit) => Promise<Response>;
		stop: () => Promise<void>;
	};

	beforeAll(async () => {
		//since the script is invoked from the directory above, need to specify index.js is in src/
		worker = await wrangler.unstable_dev("src/basicModule.ts");
	});

	afterAll(async () => {
		await worker.stop();
	});

	it("should invoke the worker and exit", async () => {
		const resp = await worker.fetch();
		expect(resp).not.toBe(undefined);

		const text = await resp.text();
		expect(text).toMatchInlineSnapshot(`"Hello World!"`);
	});
});
