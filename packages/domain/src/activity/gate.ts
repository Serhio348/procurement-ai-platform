import type { ActivityVerdict } from "@procurement/contracts";

/** Document ingest starts only after activity is confirmed. */
export function mayEnqueueDocumentJobs(verdict: ActivityVerdict): boolean {
  return verdict === "active";
}
