/**
 * Rules for ZIP packs of contest files. Unzip itself lives next to the
 * extractors; this module only names members and caps the blast radius.
 */

export const MAX_ARCHIVE_MEMBERS = 40;
export const MAX_ARCHIVE_MEMBER_BYTES = 40 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 80 * 1024 * 1024;
export const MAX_ARCHIVE_UNPACK_DEPTH = 2;

const MEMBER_HASH_PREFIX = "member/";

export function archiveMemberSourceUrl(parentSourceUrl: string, entryPath: string): string {
  const url = new URL(parentSourceUrl);
  url.hash = `${MEMBER_HASH_PREFIX}${encodeURIComponent(normalizeArchivePath(entryPath))}`;
  return url.href;
}

export function isArchiveMemberSourceUrl(sourceUrl: string): boolean {
  try {
    return new URL(sourceUrl).hash.startsWith(`#${MEMBER_HASH_PREFIX}`);
  } catch {
    return false;
  }
}

export function archiveMemberDisplayName(archiveName: string, entryPath: string): string {
  return `${archiveName} / ${normalizeArchivePath(entryPath)}`;
}

export function isJunkArchivePath(entryPath: string): boolean {
  const raw = entryPath.replaceAll("\\", "/");
  if (raw.endsWith("/")) return true;
  const normalized = normalizeArchivePath(entryPath);
  if (normalized.length === 0) return true;
  const lower = normalized.toLocaleLowerCase("en-US");
  if (lower.startsWith("__macosx/")) return true;
  const file = lower.split("/").at(-1) ?? "";
  return file === ".ds_store" || file === "thumbs.db" || file.startsWith(".");
}

export function normalizeArchivePath(entryPath: string): string {
  return entryPath
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .join("/");
}

export function archiveFitsBudget(input: {
  memberCount: number;
  memberBytes: number;
  totalBytes: number;
}): boolean {
  return (
    input.memberCount < MAX_ARCHIVE_MEMBERS &&
    input.memberBytes > 0 &&
    input.memberBytes <= MAX_ARCHIVE_MEMBER_BYTES &&
    input.totalBytes + input.memberBytes <= MAX_ARCHIVE_TOTAL_BYTES
  );
}
