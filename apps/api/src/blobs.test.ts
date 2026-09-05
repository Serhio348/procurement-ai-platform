import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentDisposition,
  contentTypeForName,
  getBlob,
  isSha256Hex,
  putBlob,
  resolveBlobDirectory,
  safeDownloadName,
} from "./blobs.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("document blobs", () => {
  it("stores and reads bytes only under a sha256 hex name", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "blobs-"));
    tmpDirs.push(directory);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const hash = createHash("sha256").update(bytes).digest("hex");

    await putBlob(directory, hash, bytes);

    expect(await getBlob(directory, hash)).toEqual(Buffer.from(bytes));
    expect(await getBlob(directory, "a".repeat(64))).toBeUndefined();
    await expect(putBlob(directory, "not-a-hash", bytes)).rejects.toThrow(/sha256/);
  });

  it("keeps Russian filenames inline for the browser", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(safeDownloadName("папка/тайный.pdf")).toBe("папкатайный.pdf");
    expect(contentTypeForName("задание.pdf")).toBe("application/pdf");
    expect(contentDisposition("Техническое задание.pdf")).toContain("filename*=UTF-8''");
    expect(contentDisposition("Техническое задание.pdf")).toContain("inline");
    expect(contentDisposition("договор.doc")).toContain("attachment");
    expect(contentDisposition("договор.doc")).toContain(".doc");
  });

  it("resolves a relative DOCUMENT_BLOB_DIR from the repo root, not apps/api cwd", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    expect(path.isAbsolute(resolveBlobDirectory(undefined))).toBe(true);
    expect(resolveBlobDirectory("data/blobs")).toBe(path.join(repoRoot, "data", "blobs"));
    expect(contentTypeForName("договор.doc")).toBe("application/msword");
  });
});
