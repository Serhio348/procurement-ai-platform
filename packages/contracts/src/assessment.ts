import { z } from "zod";
import { Confidence, IsoDateTime, PlatformInstant } from "./common.js";
import {
  ActivityAssessmentId,
  DomainProfileId,
  EvidenceId,
  ProcurementId,
  RelevanceAssessmentId,
} from "./ids.js";

export const RelevanceVerdict = z.enum(["relevant", "irrelevant", "needs_human"]);
export type RelevanceVerdict = z.infer<typeof RelevanceVerdict>;

export const RelevanceSignal = z.object({
  field: z.string().min(1),
  term: z.string().min(1),
  weight: z.number().min(0),
  evidenceIds: z.array(EvidenceId).min(1),
});
export type RelevanceSignal = z.infer<typeof RelevanceSignal>;

export const RelevanceAssessment = z.object({
  id: RelevanceAssessmentId,
  procurementId: ProcurementId,
  domainProfileId: DomainProfileId,
  formulaId: z.string().min(1),
  formulaVersion: z.number().int().positive(),
  verdict: RelevanceVerdict,
  score: z.number().min(0).max(1),
  confidence: Confidence,
  matchedSignals: z.array(RelevanceSignal).default([]),
  excludedBy: z.array(z.string().min(1)).default([]),
  /** Plain-language explanation for the specialist. */
  explanation: z.string().min(1),
  assessedAt: IsoDateTime,
});
export type RelevanceAssessment = z.infer<typeof RelevanceAssessment>;

export const NormalizedActivityStatus = z.enum([
  "accepting",
  "announced",
  "closed",
  "completed",
  "cancelled",
  "unknown",
]);
export type NormalizedActivityStatus = z.infer<typeof NormalizedActivityStatus>;

export const ActivityVerdict = z.enum(["active", "inactive", "needs_human"]);
export type ActivityVerdict = z.infer<typeof ActivityVerdict>;

export const ActivityAssessment = z.object({
  id: ActivityAssessmentId,
  procurementId: ProcurementId,
  sourceStatus: z.string().min(1),
  normalizedStatus: NormalizedActivityStatus,
  deadline: PlatformInstant.optional(),
  timeZone: z.string().optional(),
  verdict: ActivityVerdict,
  reason: z.string().min(1),
  evidenceIds: z.array(EvidenceId).min(1),
  assessedAt: IsoDateTime,
});
export type ActivityAssessment = z.infer<typeof ActivityAssessment>;
