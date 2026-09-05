import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProcurementDownloadResponse,
  Sha256,
  type ProcurementFileBytes,
} from "@procurement/contracts";

export function defaultDownloadDirectory(): string {
  return fileURLToPath(new URL("../../../data/blobs/", import.meta.url));
}

export function resolveDownloadDirectory(fromEnv: string | undefined): string {
  if (fromEnv === undefined || fromEnv.length === 0) return defaultDownloadDirectory();
  if (path.isAbsolute(fromEnv)) return fromEnv;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return path.resolve(repoRoot, fromEnv);
}

export async function storeDownloadedFile(
  file: ProcurementFileBytes,
  directory = resolveDownloadDirectory(process.env["DOCUMENT_BLOB_DIR"]),
): Promise<ReturnType<typeof ProcurementDownloadResponse.parse>> {
  const hash = Sha256.parse(createHash("sha256").update(file.bytes).digest("hex"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, hash), file.bytes);
  return ProcurementDownloadResponse.parse({
    hash,
    storageKey: `blobs/${hash}`,
    sizeBytes: file.bytes.byteLength,
    contentType: file.contentType,
  });
}
