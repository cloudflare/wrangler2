import * as fs from "node:fs";
import { Readable } from "node:stream";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import {
	setMockFetchR2Objects,
	setMockResponse,
	unsetAllMocks,
} from "./helpers/mock-cfetch";
import { mockConsoleMethods } from "./helpers/mock-console";
import { runInTempDir } from "./helpers/run-in-tmp";
import { runWrangler } from "./helpers/run-wrangler";
import type { R2BucketInfo } from "../r2";

describe("wrangler", () => {
	mockAccountId();
	mockApiToken();
	runInTempDir();
	const std = mockConsoleMethods();

	afterEach(() => {
		unsetAllMocks();
	});

	describe("r2", () => {
		describe("bucket", () => {
			it("should show the correct help when an invalid command is passed", async () => {
				await expect(() =>
					runWrangler("r2 bucket foo")
				).rejects.toThrowErrorMatchingInlineSnapshot(`"Unknown argument: foo"`);
				expect(std.err).toMatchInlineSnapshot(`
			          "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mUnknown argument: foo[0m

			          "
		        `);
				expect(std.out).toMatchInlineSnapshot(`
			          "
			          wrangler r2 bucket

			          Manage R2 buckets

			          Commands:
			            wrangler r2 bucket create <name>  Create a new R2 bucket
			            wrangler r2 bucket list           List R2 buckets
			            wrangler r2 bucket delete <name>  Delete an R2 bucket

			          Flags:
			            -c, --config   Path to .toml configuration file  [string]
			            -h, --help     Show help  [boolean]
			            -v, --version  Show version number  [boolean]"
		        `);
			});

			describe("list", () => {
				function mockListRequest(buckets: R2BucketInfo[]) {
					const requests = { count: 0 };
					setMockResponse(
						"/accounts/:accountId/r2/buckets",
						([_url, accountId], init) => {
							requests.count++;
							expect(accountId).toEqual("some-account-id");
							expect(init).toEqual({});
							return { buckets };
						}
					);
					return requests;
				}

				it("should list buckets", async () => {
					const expectedBuckets: R2BucketInfo[] = [
						{ name: "bucket-1", creation_date: "01-01-2001" },
						{ name: "bucket-2", creation_date: "01-01-2001" },
					];
					mockListRequest(expectedBuckets);
					await runWrangler("r2 bucket list");

					expect(std.err).toMatchInlineSnapshot(`""`);
					const buckets = JSON.parse(std.out);
					expect(buckets).toEqual(expectedBuckets);
				});
			});

			describe("create", () => {
				function mockCreateRequest(expectedBucketName: string) {
					const requests = { count: 0 };
					setMockResponse(
						"/accounts/:accountId/r2/buckets/:bucketName",
						"PUT",
						([_url, accountId, bucketName]) => {
							expect(accountId).toEqual("some-account-id");
							expect(bucketName).toEqual(expectedBucketName);
							requests.count += 1;
						}
					);
					return requests;
				}

				it("should error if no bucket name is given", async () => {
					await expect(
						runWrangler("r2 bucket create")
					).rejects.toThrowErrorMatchingInlineSnapshot(
						`"Not enough non-option arguments: got 0, need at least 1"`
					);
					expect(std.out).toMatchInlineSnapshot(`
				            "
				            wrangler r2 bucket create <name>

				            Create a new R2 bucket

				            Positionals:
				              name  The name of the new bucket  [string] [required]

				            Flags:
				              -c, --config   Path to .toml configuration file  [string]
				              -h, --help     Show help  [boolean]
				              -v, --version  Show version number  [boolean]"
			          `);
					expect(std.err).toMatchInlineSnapshot(`
				            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mNot enough non-option arguments: got 0, need at least 1[0m

				            "
			          `);
				});

				it("should error if the bucket to create contains spaces", async () => {
					await expect(
						runWrangler("r2 bucket create abc def ghi")
					).rejects.toThrowErrorMatchingInlineSnapshot(
						`"Unknown arguments: def, ghi"`
					);
					expect(std.out).toMatchInlineSnapshot(`
				            "
				            wrangler r2 bucket create <name>

				            Create a new R2 bucket

				            Positionals:
				              name  The name of the new bucket  [string] [required]

				            Flags:
				              -c, --config   Path to .toml configuration file  [string]
				              -h, --help     Show help  [boolean]
				              -v, --version  Show version number  [boolean]"
			          `);
					expect(std.err).toMatchInlineSnapshot(`
				            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mUnknown arguments: def, ghi[0m

				            "
			          `);
				});

				it("should create a bucket", async () => {
					const requests = mockCreateRequest("testBucket");
					await runWrangler("r2 bucket create testBucket");
					expect(std.out).toMatchInlineSnapshot(`
				            "Creating bucket testBucket.
				            Created bucket testBucket."
			          `);
					expect(requests.count).toEqual(1);
				});
			});

			describe("delete", () => {
				function mockDeleteRequest(expectedBucketName: string) {
					const requests = { count: 0 };
					setMockResponse(
						"/accounts/:accountId/r2/buckets/:bucketName",
						"DELETE",
						([_url, accountId, bucketName]) => {
							expect(accountId).toEqual("some-account-id");
							expect(bucketName).toEqual(expectedBucketName);
							requests.count += 1;
						}
					);
					return requests;
				}

				it("should error if no bucket name is given", async () => {
					await expect(
						runWrangler("r2 bucket delete")
					).rejects.toThrowErrorMatchingInlineSnapshot(
						`"Not enough non-option arguments: got 0, need at least 1"`
					);
					expect(std.out).toMatchInlineSnapshot(`
				            "
				            wrangler r2 bucket delete <name>

				            Delete an R2 bucket

				            Positionals:
				              name  The name of the bucket to delete  [string] [required]

				            Flags:
				              -c, --config   Path to .toml configuration file  [string]
				              -h, --help     Show help  [boolean]
				              -v, --version  Show version number  [boolean]"
			          `);
					expect(std.err).toMatchInlineSnapshot(`
				            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mNot enough non-option arguments: got 0, need at least 1[0m

				            "
			          `);
				});

				it("should error if the bucket name to delete contains spaces", async () => {
					await expect(
						runWrangler("r2 bucket delete abc def ghi")
					).rejects.toThrowErrorMatchingInlineSnapshot(
						`"Unknown arguments: def, ghi"`
					);
					expect(std.out).toMatchInlineSnapshot(`
				            "
				            wrangler r2 bucket delete <name>

				            Delete an R2 bucket

				            Positionals:
				              name  The name of the bucket to delete  [string] [required]

				            Flags:
				              -c, --config   Path to .toml configuration file  [string]
				              -h, --help     Show help  [boolean]
				              -v, --version  Show version number  [boolean]"
			          `);
					expect(std.err).toMatchInlineSnapshot(`
				            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mUnknown arguments: def, ghi[0m

				            "
			          `);
				});

				it("should delete a bucket specified by name", async () => {
					const requests = mockDeleteRequest("some-bucket");
					await runWrangler(`r2 bucket delete some-bucket`);
					expect(requests.count).toEqual(1);
				});
			});
		});

		describe("r2 object", () => {
			jest.spyOn(Readable, "from").mockImplementation();
			it("should download R2 object from bucket", async () => {
				setMockFetchR2Objects(
					{
						accountId: "some-account-id",
						bucketName: "bucketName-object-test",
						objectName: "wormhole-img.png",
					},
					"R2-objects-test-data"
				);

				await runWrangler(
					`r2 object get bucketName-object-test/wormhole-img.png --file ./wormhole-img.png`
				);

				expect(std.out).toMatchInlineSnapshot(`
			"Downloading \\"wormhole-img.png\\" from \\"bucketName-object-test\\".
			Download complete."
		`);
			});

			it("should upload R2 object from bucket", async () => {
				setMockFetchR2Objects(
					{
						accountId: "some-account-id",
						bucketName: "bucketName-object-test",
						objectName: "wormhole-img.png",
					},
					"R2-objects-test-data"
				);
				fs.writeFileSync("./wormhole-img.png", "passageway");
				await runWrangler(
					`r2 object put bucketName-object-test/wormhole-img.png --file ./wormhole-img.png`
				);

				expect(std.out).toMatchInlineSnapshot(`
			"Creating object \\"wormhole-img.png\\" in bucket \\"bucketName-object-test\\".
			Upload complete."
		`);
				fs.rmSync("./wormhole-img.png");
			});

			it("should pass all fetch option flags into requestInit", async () => {
				setMockFetchR2Objects(
					{
						accountId: "some-account-id",
						bucketName: "bucketName-object-test",
						objectName: "wormhole-img.png",
					},
					"R2-objects-test-data"
				);
				const flags =
					"--ct content-type --cd content-disposition --ce content-encoding --cl content-lang --cc cache-control --e expire-time";
				fs.writeFileSync("./wormhole-img.png", "passageway");
				await runWrangler(
					`r2 object put bucketName-object-test/wormhole-img.png ${flags} --file ./wormhole-img.png`
				);

				expect(std.out).toMatchInlineSnapshot(`
			"Creating object \\"wormhole-img.png\\" in bucket \\"bucketName-object-test\\".
			Upload complete."
		`);
				fs.rmSync("./wormhole-img.png");
			});
		});
	});
});
