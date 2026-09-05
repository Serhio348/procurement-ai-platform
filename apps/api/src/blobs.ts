import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/;

export function defaultBlobDirectory(): string {
  return fileURLToPath(new URL("../../../data/blobs/", import.meta.url));
}

/** Relative env paths are from the repo root, not `apps/api` cwd. */
export function resolveBlobDirectory(fromEnv: string | undefined): string {
  if (fromEnv === undefined || fromEnv.length === 0) return defaultBlobDirectory();
  if (path.isAbsolute(fromEnv)) return fromEnv;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return path.resolve(repoRoot, fromEnv);
}

export function isSha256Hex(value: string): boolean {
  return sha256Pattern.test(value);
}

export async function putBlob(directory: string, hash: string, bytes: Uint8Array): Promise<void> {
  if (!isSha256Hex(hash)) throw new Error("blob hash must be sha256 hex");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, hash), bytes);
}

export async function getBlob(directory: string, hash: string): Promise<Uint8Array | undefined> {
  if (!isSha256Hex(hash)) return undefined;
  try {
    return await readFile(path.join(directory, hash));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function safeDownloadName(name: string): string {
  const base = name.replace(/[/\\]/g, "").replace(/[\r\n"]/g, " ").trim();
  return base.length > 0 ? base : "document.bin";
}

export function opensInlineInBrowser(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

export function contentDisposition(name: string): string {
  const filename = safeDownloadName(name);
  const ascii = filename.replace(/[^\u0020-\u007E]/g, "_");
  const mode = opensInlineInBrowser(name) ? "inline" : "attachment";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function contentTypeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".doc")) return "application/msword";
  return "application/octet-stream";
}
