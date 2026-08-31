import { z } from "zod";
import { IsoDateTime } from "./common.js";
import {
  DomainProfileId,
  IntentId,
  JobRunId,
  ProcurementId,
  RequestId,
  TaskId,
} from "./ids.js";

export const JobErrorKind = z.enum(["retryable", "terminal", "needs_human"]);
export type JobErrorKind = z.infer<typeof JobErrorKind>;

export const JobStatus = z.enum(["pending", "running", "succeeded", "failed", "waiting_human"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobError = z.object({
  kind: JobErrorKind,
  message: z.string().min(1),
});
export type JobError = z.infer<typeof JobError>;

export const JobRun = z.object({
  id: JobRunId,
  kind: z.string().min(1),
  status: JobStatus,
  idempotencyKey: z.string().min(1),
  payload: z.unknown(),
  result: z.unknown().optional(),
  error: JobError.optional(),
  attempt: z.number().int().nonnegative().default(0),
  checkpoint: z.unknown().optional(),
  requestId: RequestId.optional(),
  taskId: TaskId.optional(),
  intentId: IntentId.optional(),
  domainProfileId: DomainProfileId.optional(),
  procurementId: ProcurementId.optional(),
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type JobRun = z.infer<typeof JobRun>;
