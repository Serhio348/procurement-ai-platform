import {
  archiveFitsBudget,
  isJunkArchivePath,
  normalizeArchivePath,
} from "@procurement/domain";
import { unzipEntries } from "./zip-entries.js";

export interface ArchiveMember {
  path: string;
  bytes: Uint8Array;
}

export function unpackZipArchive(bytes: Uint8Array): ArchiveMember[] {
  let entries: Map<string, Uint8Array>;
  try {
    entries = unzipEntries(bytes);
  } catch {
    return [];
  }
  const members: ArchiveMember[] = [];
  let totalBytes = 0;
  for (const [rawPath, data] of entries) {
    const path = normalizeArchivePath(rawPath);
    if (isJunkArchivePath(path)) continue;
    if (
      !archiveFitsBudget({
        memberCount: members.length,
        memberBytes: data.byteLength,
        totalBytes,
      })
    ) {
      continue;
    }
    members.push({ path, bytes: data });
    totalBytes += data.byteLength;
  }
  return members;
}
