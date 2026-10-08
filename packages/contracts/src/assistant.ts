import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { SpecialistTriageKind } from "./specialist.js";

/**
 * What the cabinet assistant remembers about one specialist decision: the
 * wording the specialist saw, not the card. It outlives the trash, so the
 * cabinet keeps learning from rejects whose cards were deleted.
 */
export const DecisionMemoryEntry = z.object({
  sourceProcurementId: z.string().min(1),
  kind: SpecialistTriageKind,
  /** Profiles that found the case. Empty: the decision is cabinet-wide. */
  profileIds: z.array(z.string().uuid()).default([]),
  title: z.string().min(1),
  lotTitles: z.array(z.string().min(1)).max(50).default([]),
  decidedAt: IsoDateTime,
});
export type DecisionMemoryEntry = z.infer<typeof DecisionMemoryEntry>;

/** One word or word pair counted over a profile's remembered decisions. */
export const AssistantTermStat = z.object({
  /** Stems joined by a space: the identity of the term. */
  key: z.string().min(1),
  /** The most frequent spelling, shown to the specialist. */
  label: z.string().min(1),
  rejectCount: z.number().int().nonnegative(),
  acceptCount: z.number().int().nonnegative(),
  /** Remembered rejects containing the term, newest first. */
  rejectExamples: z.array(z.string().min(1)).max(5).default([]),
});
export type AssistantTermStat = z.infer<typeof AssistantTermStat>;

/** Read-only view of one profile's decision memory for the pilot cabinet. */
export const AssistantTermsResponse = z.object({
  profileId: z.string().uuid(),
  rejectCount: z.number().int().nonnegative(),
  acceptCount: z.number().int().nonnegative(),
  /** Terms that already look like a reason to reject: see `rejectSignals`. */
  signals: z.array(AssistantTermStat),
  terms: z.array(AssistantTermStat),
});
export type AssistantTermsResponse = z.infer<typeof AssistantTermsResponse>;
