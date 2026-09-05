import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBlobStoreFromEnv,
  createChainedBlobStore,
  createDiskBlobStore,
  objectStoreKind,
} from "./object-store.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("blob stores", () => {
  it("writes bytes to disk under the sha256 name and reads them back", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "blobs-"));
    tmpDirs.push(directory);
    const store = createDiskBlobStore(directory);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = createHash("sha256").update(bytes).digest("hex");

    await store.put(hash, bytes);

    expect(await store.get(hash)).toEqual(Buffer.from(bytes));
    expect(await store.get("a".repeat(64))).toBeUndefined();
  });

  it("reads the primary store first and falls back when the object is missing", async () => {
    const primaryDir = await mkdtemp(path.join(os.tmpdir(), "s3-like-"));
    const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "disk-"));
    tmpDirs.push(primaryDir, fallbackDir);
    const primary = createDiskBlobStore(primaryDir);
    const fallback = createDiskBlobStore(fallbackDir);
    const store = createChainedBlobStore(primary, fallback);
    const bytes = new Uint8Array([9, 8, 7]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    await fallback.put(hash, bytes);

    expect(await store.get(hash)).toEqual(Buffer.from(bytes));
    await store.put(hash, bytes);
    expect(await primary.get(hash)).toEqual(Buffer.from(bytes));
  });

  it("keeps the disk copy when the durable store rejects a write", async () => {
    const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "disk-"));
    tmpDirs.push(fallbackDir);
    const fallback = createDiskBlobStore(fallbackDir);
    const store = createChainedBlobStore(
      {
        put: async () => {
          throw new Error("minio down");
        },
        get: async () => {
          throw new Error("minio down");
        },
      },
      fallback,
    );
    const bytes = new Uint8Array([4, 5, 6]);
    const hash = createHash("sha256").update(bytes).digest("hex");

    await store.put(hash, bytes);

    expect(await store.get(hash)).toEqual(Buffer.from(bytes));
  });

  it("uses disk when S3 settings are incomplete", () => {
    expect(objectStoreKind({})).toBe("disk");
    expect(
      objectStoreKind({
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "procurement",
        S3_SECRET_ACCESS_KEY: "secret",
        S3_BUCKET: "procurement",
      }),
    ).toBe("s3");
    expect(createBlobStoreFromEnv({}, os.tmpdir())).toBeDefined();
  });
});
