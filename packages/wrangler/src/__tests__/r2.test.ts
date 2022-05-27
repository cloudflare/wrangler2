import * as fs from "node:fs";
import { mockAccountId, mockApiToken } from "./helpers/mock-account-id";
import {
  setMockResponse,
  setMockRawResponse,
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
    describe("object", () => {
      it("should show the correct help when an invalid command is passed", async () => {
        await expect(() =>
          runWrangler("r2 object foo")
        ).rejects.toThrowErrorMatchingInlineSnapshot(`"Unknown argument: foo"`);
        expect(std.err).toMatchInlineSnapshot(`
          "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mUnknown argument: foo[0m

          "
        `);
        expect(std.out).toMatchInlineSnapshot(`
          "
          wrangler r2 object

          Manage R2 objects

          Commands:
            wrangler r2 object get <objectPath>  Fetch an object from an R2 bucket
            wrangler r2 object put <objectPath>  Create an object in an R2 bucket

          Flags:
            -c, --config   Path to .toml configuration file  [string]
            -h, --help     Show help  [boolean]
            -v, --version  Show version number  [boolean]"
        `);
      });
      describe("get", () => {
        function mockCreateBucketGetRequest(
          expectedBucketName: string,
          expectedObjectName: string,
          content: string | Buffer
        ) {
          const requests = { count: 0 };
          setMockRawResponse(
            "/accounts/:accountId/r2/buckets/:bucketName/objects/:objectName",
            "GET",
            ([_url, accountId, bucketName, objectName]) => {
              expect(accountId).toEqual("some-account-id");
              expect(bucketName).toEqual(expectedBucketName);
              expect(objectName).toEqual(expectedObjectName);
              requests.count += 1;
              return content;
            }
          );
          return requests;
        }

        it("should error if no object path is given", async () => {
          await expect(
            runWrangler("r2 object get")
          ).rejects.toThrowErrorMatchingInlineSnapshot(
            `"Not enough non-option arguments: got 0, need at least 1"`
          );
          expect(std.out).toMatchInlineSnapshot(`
            "
            wrangler r2 object get <objectPath>

            Fetch an object from an R2 bucket
            
            Positionals:
              objectPath  The source object path in the form of {bucket}/{key}  [string] [required]
            
            Flags:
              -c, --config   Path to .toml configuration file  [string]
              -h, --help     Show help  [boolean]
              -v, --version  Show version number  [boolean]
            
            Options:
              -f, --file  The destination file to create  [string]
              -p, --pipe  Enables the file to be piped to a destination, rather than specified with the --file option  [boolean]"
          `);
          expect(std.err).toMatchInlineSnapshot(`
            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mNot enough non-option arguments: got 0, need at least 1[0m

            "
          `);
        });

        it("should error if only a bucket is given", async () => {
          await expect(
            runWrangler("r2 object get cats")
          ).rejects.toThrowErrorMatchingInlineSnapshot(
            `"The object path must be in the form of {bucket}/{key}"`
          );
          expect(std.out).toMatchInlineSnapshot(`
            "
            wrangler r2 object get <objectPath>

            Fetch an object from an R2 bucket
            
            Positionals:
              objectPath  The source object path in the form of {bucket}/{key}  [string] [required]
            
            Flags:
              -c, --config   Path to .toml configuration file  [string]
              -h, --help     Show help  [boolean]
              -v, --version  Show version number  [boolean]
            
            Options:
              -f, --file  The destination file to create  [string]
              -p, --pipe  Enables the file to be piped to a destination, rather than specified with the --file option  [boolean]"
          `);
          expect(std.err).toMatchInlineSnapshot(`
            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mThe object path must be in the form of {bucket}/{key}[0m

            "
          `);
        });

        it("should error if the object to get contains spaces", async () => {
          await expect(
            runWrangler("r2 object get cats/kitty.jpg meow")
          ).rejects.toThrowErrorMatchingInlineSnapshot(
            `"Unknown argument: meow"`
          );
          expect(std.out).toMatchInlineSnapshot(`
            "
            wrangler r2 object get <objectPath>

            Fetch an object from an R2 bucket
            
            Positionals:
              objectPath  The source object path in the form of {bucket}/{key}  [string] [required]
            
            Flags:
              -c, --config   Path to .toml configuration file  [string]
              -h, --help     Show help  [boolean]
              -v, --version  Show version number  [boolean]
            
            Options:
              -f, --file  The destination file to create  [string]
              -p, --pipe  Enables the file to be piped to a destination, rather than specified with the --file option  [boolean]"
          `);
          expect(std.err).toMatchInlineSnapshot(`
            "[31mX [41;31m[[41;97mERROR[41;31m][0m [1mUnknown argument: meow[0m

            "
          `);
        });

        it("should get an object", async () => {
          const requests = mockCreateBucketGetRequest(
            "cats",
            "kitty.txt",
            "meow"
          );
          await runWrangler("r2 object get cats/kitty.txt");
          const text = fs.readFileSync("./kitty.txt", { encoding: "utf8" });
          expect(std.out).toMatchInlineSnapshot(`
            "Downloading "cat1.webp" from "cats".
            Download complete."
          `);
          expect(requests.count).toEqual(1);
          expect(text).toEqual("meow");
        });
      });
    });
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
  });
});
