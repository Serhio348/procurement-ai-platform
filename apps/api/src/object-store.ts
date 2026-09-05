import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getBlob, isSha256Hex, putBlob } from "./blobs.js";

export interface BlobStore {
  put: (hash: string, bytes: Uint8Array) => Promise<void>;
  get: (hash: string) => Promise<Uint8Array | undefined>;
}

export function createDiskBlobStore(directory: string): BlobStore {
  return {
    put: (hash, bytes) => putBlob(directory, hash, bytes),
    get: (hash) => getBlob(directory, hash),
  };
}

export function createS3BlobStore(options: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): BlobStore {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  });
  return {
    async put(hash, bytes) {
      if (!isSha256Hex(hash)) throw new Error("blob hash must be sha256 hex");
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: `blobs/${hash}`,
          Body: Buffer.from(bytes),
        }),
      );
    },
    async get(hash) {
      if (!isSha256Hex(hash)) return undefined;
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: options.bucket,
            Key: `blobs/${hash}`,
          }),
        );
        const body = response.Body;
        if (body === undefined) return undefined;
        return new Uint8Array(await body.transformToByteArray());
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return undefined;
        throw error;
      }
    },
  };
}

/** Durable object store first, local scratch second. */
export function createChainedBlobStore(primary: BlobStore, fallback: BlobStore): BlobStore {
  return {
    async put(hash, bytes) {
      await fallback.put(hash, bytes);
      try {
        await primary.put(hash, bytes);
      } catch {
        // MinIO/S3 down: the sha256 file remains on disk.
      }
    },
    async get(hash) {
      try {
        const found = await primary.get(hash);
        if (found !== undefined) return found;
      } catch {
        // Serve the local scratch copy when the durable store is unreachable.
      }
      return fallback.get(hash);
    },
  };
}

export function objectStoreKind(env: NodeJS.ProcessEnv): "s3" | "disk" {
  const endpoint = env["S3_ENDPOINT"]?.trim() ?? "";
  const accessKeyId = env["S3_ACCESS_KEY_ID"]?.trim() ?? "";
  const secretAccessKey = env["S3_SECRET_ACCESS_KEY"]?.trim() ?? "";
  const bucket = env["S3_BUCKET"]?.trim() ?? "";
  if (endpoint.length === 0 || accessKeyId.length === 0 || secretAccessKey.length === 0 || bucket.length === 0) {
    return "disk";
  }
  return "s3";
}

export function createBlobStoreFromEnv(
  env: NodeJS.ProcessEnv,
  diskDirectory: string,
): BlobStore {
  const disk = createDiskBlobStore(diskDirectory);
  if (objectStoreKind(env) === "disk") return disk;
  return createChainedBlobStore(
    createS3BlobStore({
      endpoint: env["S3_ENDPOINT"]?.trim() ?? "",
      region: env["S3_REGION"]?.trim() || "us-east-1",
      bucket: env["S3_BUCKET"]?.trim() ?? "",
      accessKeyId: env["S3_ACCESS_KEY_ID"]?.trim() ?? "",
      secretAccessKey: env["S3_SECRET_ACCESS_KEY"]?.trim() ?? "",
    }),
    disk,
  );
}
