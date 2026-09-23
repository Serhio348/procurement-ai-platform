import {
  archiveFitsBudget,
  isJunkArchivePath,
  normalizeArchivePath,
  type DocumentFileFormat,
} from "@procurement/domain";
import { createRequire } from "node:module";
import type { SevenZipModule, SevenZipModuleFactory } from "7z-wasm";
import { unzipEntries } from "./zip-entries.js";

// 7z-wasm ships UMD: under NodeNext its types bind the default import to the
// module namespace, while the runtime value is the factory itself.
const SevenZip = createRequire(import.meta.url)("7z-wasm") as SevenZipModuleFactory;

export interface ArchiveMember {
  path: string;
  bytes: Uint8Array;
}

export interface UnpackedArchive {
  members: ArchiveMember[];
  /** Set when the container itself could not be opened at all. */
  error?: string;
}

export function unpackZipArchive(bytes: Uint8Array): ArchiveMember[] {
  let entries: Map<string, Uint8Array>;
  try {
    entries = unzipEntries(bytes);
  } catch {
    return [];
  }
  return fitMembers(entries);
}

/**
 * Unpacks a contest archive. ZIP goes through the native reader; RAR and 7z
 * go through 7-Zip compiled to WASM — no system binaries needed on the host.
 * A broken container reports `error` instead of pretending to be empty.
 */
export async function unpackArchive(
  format: DocumentFileFormat,
  bytes: Uint8Array,
): Promise<UnpackedArchive> {
  if (format === "zip") {
    try {
      return { members: fitMembers(unzipEntries(bytes)) };
    } catch (error) {
      return { members: [], error: String(error) };
    }
  }
  if (format === "rar" || format === "7z") {
    return unpackWith7z(bytes);
  }
  return { members: [], error: `Формат ${format} не является архивом.` };
}

function fitMembers(entries: ReadonlyMap<string, Uint8Array>): ArchiveMember[] {
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

async function unpackWith7z(bytes: Uint8Array): Promise<UnpackedArchive> {
  // A fresh module per archive: stderr is captured per job and a WASM abort
  // cannot poison the next unpack. 7zz exits 0 even on a broken container —
  // its diagnostics land on stderr instead.
  const errors: string[] = [];
  let seven: SevenZipModule;
  try {
    seven = await SevenZip({
      printErr: (line) => errors.push(line),
      print: () => undefined,
    });
  } catch (error) {
    return { members: [], error: `7-Zip WASM не загрузился: ${String(error)}` };
  }
  const job = `/unpack-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  const out = `${job}/out`;
  try {
    seven.FS.mkdir(job);
    seven.FS.writeFile(`${job}/pack`, bytes);
    seven.FS.mkdir(out);
    // 7zz detects the container by magic bytes, so a fixed «pack» name is
    // enough — no need to trust the remote file extension.
    seven.callMain(["x", "-y", `-o${out}`, `${job}/pack`]);
  } catch (error) {
    cleanupJob(seven, job);
    return { members: [], error: `Архив не открылся: ${String(error)}` };
  }
  try {
    const entries = new Map<string, Uint8Array>();
    collectDirectory(seven, out, out, entries);
    const reported = errors
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "ERRORS:")
      .at(-1);
    return {
      members: fitMembers(entries),
      ...(reported === undefined ? {} : { error: reported }),
    };
  } finally {
    cleanupJob(seven, job);
  }
}

function collectDirectory(
  seven: SevenZipModule,
  root: string,
  dir: string,
  into: Map<string, Uint8Array>,
): void {
  for (const name of seven.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const full = `${dir}/${name}`;
    const stat = seven.FS.stat(full);
    if (seven.FS.isDir(stat.mode)) {
      collectDirectory(seven, root, full, into);
      continue;
    }
    if (!seven.FS.isFile(stat.mode)) continue;
    const relative = full.slice(root.length + 1);
    into.set(relative, seven.FS.readFile(full));
  }
}

function cleanupJob(seven: SevenZipModule, job: string): void {
  try {
    const entries = new Map<string, Uint8Array>();
    collectDirectory(seven, job, job, entries);
    for (const path of entries.keys()) {
      seven.FS.unlink(`${job}/${path}`);
    }
    removeEmptyDirs(seven, job);
    seven.FS.rmdir(job);
  } catch {
    // Memfs cleanup is best-effort; a half-extracted tree must not mask the
    // real extraction result.
  }
}

function removeEmptyDirs(seven: SevenZipModule, dir: string): void {
  for (const name of seven.FS.readdir(dir)) {
    if (name === "." || name === "..") continue;
    const full = `${dir}/${name}`;
    if (seven.FS.isDir(seven.FS.stat(full).mode)) {
      removeEmptyDirs(seven, full);
      seven.FS.rmdir(full);
    }
  }
}
