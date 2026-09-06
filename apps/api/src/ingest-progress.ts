import {
  ProcurementId,
  SpecialistIngestProgress,
  type SpecialistIngestFileProgress,
  type SpecialistIngestFileState,
} from "@procurement/contracts";
import { ingestOverallPercent } from "@procurement/domain";

export interface IngestProgressHub {
  snapshot: (procurementId: string) => ReturnType<typeof SpecialistIngestProgress.parse>;
  begin: (procurementId: string) => void;
  listed: (procurementId: string, files: readonly { name: string; sourceUrl: string }[]) => void;
  fileDownloading: (procurementId: string, sourceUrl: string) => void;
  fileIndexing: (procurementId: string, sourceUrl: string, percent: number, hash?: string) => void;
  fileFinished: (
    procurementId: string,
    sourceUrl: string,
    state: Extract<SpecialistIngestFileState, "read" | "skipped" | "failed">,
    hash?: string,
  ) => void;
  done: (procurementId: string) => void;
  fail: (procurementId: string) => void;
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

  const publish = (
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
      procurementId,
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

  const current = (procurementId: string) => byId.get(procurementId) ?? idleIngestProgress(procurementId);

  const replaceFile = (
    procurementId: string,
    sourceUrl: string,
    patch: Partial<SpecialistIngestFileProgress>,
    phase: ReturnType<typeof SpecialistIngestProgress.parse>["phase"],
  ): void => {
    const previous = current(procurementId);
    const files = previous.files.map((item) =>
      item.sourceUrl === sourceUrl ? { ...item, ...patch } : item,
    );
    const active = files.find((item) => item.sourceUrl === sourceUrl);
    publish(procurementId, files, phase, active?.name);
  };

  return {
    snapshot(procurementId) {
      return current(procurementId);
    },
    begin(procurementId) {
      publish(procurementId, [], "listing");
    },
    listed(procurementId, files) {
      publish(
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
    fileDownloading(procurementId, sourceUrl) {
      replaceFile(procurementId, sourceUrl, { state: "downloading", percent: 10 }, "downloading");
    },
    fileIndexing(procurementId, sourceUrl, percent, hash) {
      replaceFile(
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
    fileFinished(procurementId, sourceUrl, state, hash) {
      replaceFile(
        procurementId,
        sourceUrl,
        { state, percent: 100, ...(hash === undefined ? {} : { hash }) },
        "indexing",
      );
    },
    done(procurementId) {
      const previous = current(procurementId);
      publish(procurementId, previous.files, "done");
    },
    fail(procurementId) {
      const previous = current(procurementId);
      publish(procurementId, previous.files, "failed");
    },
  };
}
