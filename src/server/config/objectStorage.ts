import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { createLogger } from "../utils/logger.js";

const log = createLogger("storage");

// MinIO is S3-compatible: same SDK, custom endpoint + path-style addressing.
// Swapping MINIO_ENDPOINT/creds for real AWS S3 needs no code change.
//
// MINIO_ENDPOINT is relative to wherever THIS PROCESS runs, not the host — see
// .env.example for the full breakdown (host vs. containerized-with-MinIO vs.
// containerized-with-MinIO-on-host / host.docker.internal). The 127.0.0.1
// default below only works when this process runs directly on the host.
const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const bucket = process.env.MINIO_BUCKET || "ai-therapist-recordings";
const accessKeyId = process.env.MINIO_ROOT_USER || process.env.AWS_ACCESS_KEY_ID || "";
const secretAccessKey =
  process.env.MINIO_ROOT_PASSWORD || process.env.AWS_SECRET_ACCESS_KEY || "";

export const RECORDINGS_BUCKET = bucket;

let client: S3Client | null = null;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      endpoint,
      region: process.env.AWS_REGION || "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true, // required for MinIO
    });
  }
  return client;
}

/** Create the recordings bucket if it doesn't already exist. Safe to call repeatedly. */
export async function ensureBucket(): Promise<void> {
  const s3 = getClient();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return; // exists
  } catch {
    // fall through to create
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    log.info(`Created object-storage bucket "${bucket}"`);
  } catch (err) {
    log.error({ err }, `Failed to ensure bucket "${bucket}"`);
    throw err;
  }
}

/** Upload an object (used for finalized recordings). */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Delete an object (used when sweeping expired demo-account recordings). */
export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export interface ObjectMeta {
  contentLength: number;
  contentType: string;
}

/** Fetch object size/type without downloading the body (for Range playback). */
export async function headObject(key: string): Promise<ObjectMeta | null> {
  try {
    const res = await getClient().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

/**
 * Stream an object body, optionally a byte range. Returns the Node Readable
 * (the SDK returns a Readable in Node) plus the resolved content length.
 */
export async function getObjectStream(
  key: string,
  range?: { start: number; end: number },
): Promise<{ body: Readable; contentLength: number; contentType: string }> {
  const res = await getClient().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined,
    }),
  );
  return {
    body: res.Body as Readable,
    contentLength: res.ContentLength ?? 0,
    contentType: res.ContentType ?? "application/octet-stream",
  };
}
