import {
  ProcurementId,
  SpecialistIngestProgress,
  type SpecialistIngestFileProgress,
  type SpecialistIngestFileState,
} from "@procurement/contracts";
import { ingestOverallPercent } from "@procurement/domain";

/**
 * Progress entries are keyed by `{workspaceId, procurementId}`: the card id
 * is derived from the source row, so two cabinets hold the same id — a
 * cabinet must never see or deduplicate another cabinet's job (R17).
 */
export interface IngestProgressHub {
  snapshot: (
    workspaceId: string,
    procurementId: string,
  ) => ReturnType<typeof SpecialistIngestProgress.parse>;
  begin: (workspaceId: string, procurementId: string) => void;
  listed: (
    workspaceId: string,
    procurementId: string,
    files: readonly { name: string; sourceUrl: string }[],
  ) => void;
  fileDownloading: (workspaceId: string, procurementId: string, sourceUrl: string) => void;
  fileIndexing: (
    workspaceId: string,
    procurementId: string,
    sourceUrl: string,
    percent: number,
    hash?: string,
  ) => void;
  fileFinished: (
    workspaceId: string,
    procurementId: string,
    sourceUrl: string,
    state: Extract<SpecialistIngestFileState, "read" | "skipped" | "failed">,
    hash?: string,
  ) => void;
  done: (workspaceId: string, procurementId: string) => void;
  fail: (workspaceId: string, procurementId: string) => void;
}

export function idleIngestProgress(
  procurementId: string,
): ReturnType<typeof SpecialistIngestProgress.parse> {
  return SpecialistIngestProgress.parse({
    procurementId: ProcurementId.parse(procurementId),
    phase: "idle",
    total: 0,
    downloaded: 0,
    indexed: 0,
    readCount: 0,
    percent: 0,
    files: [],
  });
}

export function createIngestProgressHub(): IngestProgressHub {
  const byId = new Map<string, ReturnType<typeof SpecialistIngestProgress.parse>>();
  const key = (workspaceId: string, procurementId: string): string =>
    `${workspaceId}:${procurementId}`;

  const publish = (
    workspaceId: string,
    procurementId: string,
    files: SpecialistIngestFileProgress[],
    phase: ReturnType<typeof SpecialistIngestProgress.parse>["phase"],
    currentName?: string,
  ): void => {
    const downloaded = files.filter((item) => item.state !== "pending" && item.state !== "failed").length;
    const indexed = files.filter(
      (item) => item.state === "read" || item.state === "skipped" || item.state === "failed",
    ).length;
    const readCount = files.filter((item) => item.state === "read").length;
    byId.set(
      key(workspaceId, procurementId),
      SpecialistIngestProgress.parse({
        procurementId: ProcurementId.parse(procurementId),
        phase,
        total: files.length,
        downloaded,
        indexed,
        readCount,
        percent: phase === "done" ? 100 : ingestOverallPercent(files),
        files,
        ...(currentName === undefined ? {} : { currentName }),
      }),
    );
  };

  const current = (workspaceId: string, procurementId: string) =>
    byId.get(key(workspaceId, procurementId)) ?? idleIngestProgress(procurementId);

  const replaceFile = (
    workspaceId: string,
    procurementId: string,
    sourceUrl: string,
    patch: Partial<SpecialistIngestFileProgress>,
    phase: ReturnType<typeof SpecialistIngestProgress.parse>["phase"],
  ): void => {
    const previous = current(workspaceId, procurementId);
    const files = previous.files.map((item) =>
      item.sourceUrl === sourceUrl ? { ...item, ...patch } : item,
    );
    const active = files.find((item) => item.sourceUrl === sourceUrl);
    publish(workspaceId, procurementId, files, phase, active?.name);
  };

  return {
    snapshot(workspaceId, procurementId) {
      return current(workspaceId, procurementId);
    },
    begin(workspaceId, procurementId) {
      publish(workspaceId, procurementId, [], "listing");
    },
    listed(workspaceId, procurementId, files) {
      publish(
        workspaceId,
        procurementId,
        files.map((file) => ({
          name: file.name,
          sourceUrl: file.sourceUrl,
          state: "pending",
          percent: 0,
        })),
        files.length === 0 ? "done" : "downloading",
      );
    },
    fileDownloading(workspaceId, procurementId, sourceUrl) {
      replaceFile(workspaceId, procurementId, sourceUrl, { state: "downloading", percent: 10 }, "downloading");
    },
    fileIndexing(workspaceId, procurementId, sourceUrl, percent, hash) {
      replaceFile(
        workspaceId,
        procurementId,
        sourceUrl,
        {
          state: "indexing",
          percent: Math.min(100, Math.max(0, Math.round(percent))),
          ...(hash === undefined ? {} : { hash }),
        },
        "indexing",
      );
    },
    fileFinished(workspaceId, procurementId, sourceUrl, state, hash) {
      replaceFile(
        workspaceId,
        procurementId,
        sourceUrl,
        { state, percent: 100, ...(hash === undefined ? {} : { hash }) },
        "indexing",
      );
    },
    done(workspaceId, procurementId) {
      const previous = current(workspaceId, procurementId);
      publish(workspaceId, procurementId, previous.files, "done");
    },
    fail(workspaceId, procurementId) {
      const previous = current(workspaceId, procurementId);
      publish(workspaceId, procurementId, previous.files, "failed");
    },
  };
}

/**
 * Per-cabinet view of the hub: callers pass only the card's procurement id,
 * the scope is baked in (R17).
 */
export interface ScopedIngestProgress {
  snapshot: (
    procurementId: string,
  ) => ReturnType<typeof SpecialistIngestProgress.parse>;
  begin: (procurementId: string) => void;
  listed: (
    procurementId: string,
    files: readonly { name: string; sourceUrl: string }[],
  ) => void;
  fileDownloading: (procurementId: string, sourceUrl: string) => void;
  fileIndexing: (
    procurementId: string,
    sourceUrl: string,
    percent: number,
    hash?: string,
  ) => void;
  fileFinished: (
    procurementId: string,
    sourceUrl: string,
    state: Extract<SpecialistIngestFileState, "read" | "skipped" | "failed">,
    hash?: string,
  ) => void;
  done: (procurementId: string) => void;
  fail: (procurementId: string) => void;
}

/**
 * Binds a shared hub to one cabinet so document-ingest internals keep using
 * the bare procurement id while every entry lands under that cabinet's
 * scope (R17).
 */
export function bindIngestScope(
  hub: IngestProgressHub | undefined,
  workspaceId: string,
): ScopedIngestProgress | undefined {
  if (hub === undefined) return undefined;
  return {
    snapshot: (procurementId) => hub.snapshot(workspaceId, procurementId),
    begin: (procurementId) => hub.begin(workspaceId, procurementId),
    listed: (procurementId, files) => hub.listed(workspaceId, procurementId, files),
    fileDownloading: (procurementId, sourceUrl) =>
      hub.fileDownloading(workspaceId, procurementId, sourceUrl),
    fileIndexing: (procurementId, sourceUrl, percent, hash) =>
      hub.fileIndexing(workspaceId, procurementId, sourceUrl, percent, hash),
    fileFinished: (procurementId, sourceUrl, state, hash) =>
      hub.fileFinished(workspaceId, procurementId, sourceUrl, state, hash),
    done: (procurementId) => hub.done(workspaceId, procurementId),
    fail: (procurementId) => hub.fail(workspaceId, procurementId),
  };
}
