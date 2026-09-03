import { z } from "zod";
import { IsoDateTime, PlatformInstant, Sha256 } from "./common.js";
import { ChangeEvent, ProcedureStatus } from "./procurement.js";

export const MonitoredDocument = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  downloadUrl: z.string().url().optional(),
  hash: Sha256.optional(),
});
export type MonitoredDocument = z.infer<typeof MonitoredDocument>;

/**
 * Last observed card/listing slice. The orchestrator stores this between
 * runs; the agent itself does not persist.
 */
export const MonitoringSnapshot = z.object({
  status: ProcedureStatus,
  sourceStatus: z.string().optional(),
  bidsDeadline: PlatformInstant.optional(),
  documents: z.array(MonitoredDocument).default([]),
  fetchedAt: IsoDateTime,
});
export type MonitoringSnapshot = z.infer<typeof MonitoringSnapshot>;

export const MonitoringInput = z.object({
  previous: MonitoringSnapshot.optional(),
  since: IsoDateTime.optional(),
  /** Hashes from a prior ingest, keyed by listing URL. */
  documentHashes: z.array(MonitoredDocument.pick({ sourceUrl: true, hash: true })).default([]),
});
export type MonitoringInput = z.infer<typeof MonitoringInput>;

export const MonitoringOutput = z.object({
  snapshot: MonitoringSnapshot,
  changes: z.array(ChangeEvent),
  unchanged: z.boolean(),
  checkedAt: IsoDateTime,
});
export type MonitoringOutput = z.infer<typeof MonitoringOutput>;
