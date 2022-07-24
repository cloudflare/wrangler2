import { Readable } from "node:stream";
import { fetchResult } from "./cfetch";
import { fetchR2Objects } from "./cfetch/internal";
import type { BodyInit, HeadersInit } from "undici";

/**
 * Information about a bucket, returned from `listR2Buckets()`.
 */
export interface R2BucketInfo {
	name: string;
	creation_date: string;
}

/**
 * Fetch a list of all the buckets under the given `accountId`.
 */
export async function listR2Buckets(
	accountId: string
): Promise<R2BucketInfo[]> {
	const results = await fetchResult<{
		buckets: R2BucketInfo[];
	}>(`/accounts/${accountId}/r2/buckets`);
	return results.buckets;
}

/**
 * Create a bucket with the given `bucketName` within the account given by `accountId`.
 *
 * A 400 is returned if the account already owns a bucket with this name.
 * A bucket must be explicitly deleted to be replaced.
 */
export async function createR2Bucket(
	accountId: string,
	bucketName: string
): Promise<void> {
	return await fetchResult<void>(
		`/accounts/${accountId}/r2/buckets/${bucketName}`,
		{ method: "PUT" }
	);
}

/**
 * Delete a bucket with the given name
 */
export async function deleteR2Bucket(
	accountId: string,
	bucketName: string
): Promise<void> {
	return await fetchResult<void>(
		`/accounts/${accountId}/r2/buckets/${bucketName}`,
		{ method: "DELETE" }
	);
}

export function bucketAndKeyFromObjectPath(objectPath = ""): {
	bucket: string;
	key: string;
} {
	const [bucket, ...pieces] = objectPath.split("/").filter((p) => !!p);
	const key = pieces.join("/");
	if (!bucket || !key) {
		throw new Error(
			`The object path must be in the form of {bucket}/{key} you provided ${bucket}/${key}`
		);
	}
	return { bucket, key };
}

/**
 * Downloads an object
 */
export async function getR2Object(
	accountId: string,
	bucketName: string,
	objectName: string
): Promise<Readable> {
	const response = await fetchR2Objects(
		`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectName}`,
		{ method: "GET" }
	);

	return Readable.from(response.body);
}

/**
 * Uploads an object
 */
export async function putR2Object(
	accountId: string,
	bucketName: string,
	objectName: string,
	object: BodyInit,
	options: Record<string, unknown>
): Promise<void> {
	const headerKeys = [
		"content-length",
		"content-type",
		"content-disposition",
		"content-encoding",
		"content-language",
		"cache-control",
		"expires",
	];
	const headers: HeadersInit = {};
	for (const key of headerKeys) {
		const value = options[key] || "";
		if (value && typeof value === "string") headers[key] = value;
	}

	await fetchR2Objects(
		`/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectName}`,
		{
			body: object,
			headers,
			method: "PUT",
		}
	);
}
