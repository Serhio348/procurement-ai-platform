import type {
  SpecialistCaseDocument,
  SpecialistIngestFileProgress,
  SpecialistIngestFileState,
  SpecialistIngestProgress,
} from "@procurement/contracts";

export function isIngestRunning(
  phase: SpecialistIngestProgress["phase"] | undefined,
): boolean {
  return phase === "listing" || phase === "downloading" || phase === "indexing";
}

/** Download is the cheap slice of one file; recognition is the rest. */
const DOWNLOAD_WEIGHT = 20;

export function specialistDocumentWasRead(document: SpecialistCaseDocument): boolean {
  const kind = document.extraction?.kind;
  return kind === "digital_text" || kind === "office_text" || kind === "ocr_scan";
}

export function ingestFileFinishState(
  document: SpecialistCaseDocument,
): Extract<SpecialistIngestFileState, "read" | "skipped" | "failed"> {
  if (document.status === "download_failed") return "failed";
  return specialistDocumentWasRead(document) ? "read" : "skipped";
}

export function ingestFileWeight(state: SpecialistIngestFileState, percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  switch (state) {
    case "pending":
      return 0;
    case "downloading":
      return Math.min(DOWNLOAD_WEIGHT, clamped);
    case "indexing":
      return DOWNLOAD_WEIGHT + Math.round((clamped / 100) * (100 - DOWNLOAD_WEIGHT));
    case "read":
    case "skipped":
    case "failed":
      return 100;
  }
}

export function ingestOverallPercent(
  files: readonly Pick<SpecialistIngestFileProgress, "state" | "percent">[],
): number {
  if (files.length === 0) return 0;
  const sum = files.reduce((total, file) => total + ingestFileWeight(file.state, file.percent), 0);
  return Math.round(sum / files.length);
}
