import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { SpecialistTriageKind, SpecialistWorkingProfile } from "./specialist.js";

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

/**
 * A rule the assistant offers once: exclude a term from one profile. Code
 * picked it from the cabinet's own decisions; nothing changes until the
 * specialist accepts. A dismissed term is never offered again for that
 * profile, so the row stays as the memory of the refusal.
 */
export const AssistantSuggestionState = z.enum(["open", "accepted", "dismissed"]);
export type AssistantSuggestionState = z.infer<typeof AssistantSuggestionState>;

export const AssistantSuggestion = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  termKey: z.string().min(1),
  label: z.string().min(1),
  rejectCount: z.number().int().nonnegative(),
  examples: z.array(z.string().min(1)).max(5).default([]),
  state: AssistantSuggestionState,
  createdAt: IsoDateTime,
});
export type AssistantSuggestion = z.infer<typeof AssistantSuggestion>;

/** Open suggestion as the console shows it: the profile name is resolved. */
export const AssistantSuggestionEntry = AssistantSuggestion.extend({
  profileName: z.string(),
});
export type AssistantSuggestionEntry = z.infer<typeof AssistantSuggestionEntry>;

export const AssistantSuggestionListResponse = z.object({
  items: z.array(AssistantSuggestionEntry),
});
export type AssistantSuggestionListResponse = z.infer<typeof AssistantSuggestionListResponse>;

export const AssistantSuggestionResolveWrite = z.object({
  action: z.enum(["accept", "dismiss"]),
});
export type AssistantSuggestionResolveWrite = z.infer<typeof AssistantSuggestionResolveWrite>;

/**
 * Open offers after the answer, plus the profile «Принять» changed: the
 * console swaps its copy so a later editor save cannot drop the exclusion.
 */
export const AssistantSuggestionResolveResponse = AssistantSuggestionListResponse.extend({
  profile: SpecialistWorkingProfile.optional(),
});
export type AssistantSuggestionResolveResponse = z.infer<typeof AssistantSuggestionResolveResponse>;

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
