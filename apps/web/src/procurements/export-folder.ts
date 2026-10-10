import type { SpecialistProcurementExport } from "@procurement/contracts";
import {
  CARD_EXPORT_README_NAME,
  exportFolderCandidates,
  exportOwnerId,
  selectExportFolderName,
  type ExistingExportFolder,
} from "@procurement/domain";
import { throwApiError, withCredentials } from "../api/http.js";

export interface ExportWritable {
  write(data: string | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

export interface ExportFileHandle {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<ExportWritable>;
}

export interface ExportDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ExportDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<ExportFileHandle>;
}

/** Parent folder the specialist picked. The browser does not give a full path. */
export interface RememberedDirectory extends ExportDirectory {
  readonly name: string;
  queryPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

const DB_NAME = "procurement-export";
const STORE = "handles";
const PARENT_KEY = "parent";

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function isWritableStream(value: ExportWritable): value is ExportWritable & WritableStream<Uint8Array> {
  return typeof (value as { getWriter?: unknown }).getWriter === "function";
}

async function openChild(parent: ExportDirectory, name: string): Promise<ExportDirectory | undefined> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function readOwner(dir: ExportDirectory): Promise<string | undefined> {
  try {
    const handle = await dir.getFileHandle(CARD_EXPORT_README_NAME);
    return exportOwnerId(await (await handle.getFile()).text());
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeContents(handle: ExportFileHandle, data: string | Response): Promise<void> {
  const writable = await handle.createWritable();
  try {
    if (typeof data === "string") {
      await writable.write(data);
      await writable.close();
      return;
    }
    if (data.body !== null && isWritableStream(writable)) {
      await data.body.pipeTo(writable);
      return;
    }
    await writable.write(new Uint8Array(await data.arrayBuffer()));
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

/**
 * Creates or updates the card folder under `parent`. A directory that already
 * belongs to another procurement, or has no карточка.txt, is not overwritten.
 */
export async function writeExportFolder(
  parent: ExportDirectory,
  plan: SpecialistProcurementExport,
  download: (hash: string) => Promise<Response>,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const existing: ExistingExportFolder[] = [];
  for (const name of exportFolderCandidates(plan.folderName, plan.sourceProcurementId)) {
    const child = await openChild(parent, name);
    if (child === undefined) continue;
    existing.push({ name, ownerId: await readOwner(child) });
  }
  const folderName = selectExportFolderName(plan.folderName, plan.sourceProcurementId, existing);
  const folder = await parent.getDirectoryHandle(folderName, { create: true });
  const readme = await folder.getFileHandle(plan.readmeName, { create: true });
  await writeContents(readme, plan.readme);
  const total = plan.files.length;
  for (let index = 0; index < plan.files.length; index += 1) {
    const file = plan.files[index];
    if (file === undefined) continue;
    onProgress?.(index + 1, total);
    const response = await download(file.hash);
    const handle = await folder.getFileHandle(file.name, { create: true });
    await writeContents(handle, response);
  }
  return folderName;
}

function openExportDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

export async function loadExportDirectory(): Promise<RememberedDirectory | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openExportDb();
  try {
    const stored = await new Promise<RememberedDirectory | undefined>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(PARENT_KEY);
      request.onsuccess = () => resolve(request.result as RememberedDirectory | undefined);
      request.onerror = () => reject(request.error ?? new Error("indexedDB"));
    });
    return stored;
  } finally {
    db.close();
  }
}

export async function saveExportDirectory(handle: RememberedDirectory): Promise<void> {
  const db = await openExportDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(handle, PARENT_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("indexedDB"));
    });
  } finally {
    db.close();
  }
}

interface DirectoryPicker {
  showDirectoryPicker?: (options?: { mode?: "readwrite"; id?: string }) => Promise<RememberedDirectory>;
}

export function folderExportSupported(): boolean {
  return typeof (window as DirectoryPicker).showDirectoryPicker === "function";
}

export async function pickExportDirectory(): Promise<RememberedDirectory> {
  const picker = (window as DirectoryPicker).showDirectoryPicker;
  if (picker === undefined) {
    throw new Error("Выгрузка в папку работает в Chrome и Edge.");
  }
  return picker.call(window, { mode: "readwrite", id: "procurement-card-export" });
}

export function pickerWasCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function directoryGranted(handle: RememberedDirectory): Promise<boolean> {
  const mode = { mode: "readwrite" as const };
  if ((await handle.queryPermission(mode)) === "granted") return true;
  return (await handle.requestPermission(mode)) === "granted";
}

/** First await of a click. A fetch before this loses the browser's permission gesture. */
export async function acquireExportDirectory(
  current: RememberedDirectory | undefined,
): Promise<RememberedDirectory> {
  if (current !== undefined) {
    try {
      if (await directoryGranted(current)) return current;
    } catch {
      // The saved handle no longer opens. Ask for a folder again.
    }
  }
  const picked = await pickExportDirectory();
  await saveExportDirectory(picked);
  return picked;
}

export async function downloadExportFile(hash: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const response = await fetcher(`/api/documents/${hash}`, withCredentials());
  if (!response.ok) await throwApiError(response, "Не удалось скачать файл");
  return response;
}
