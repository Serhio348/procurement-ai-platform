import { z } from "zod";
import { IsoDate, IsoDateTime, Sha256 } from "./common.js";
import { ExtractedPage, ExtractionStatus } from "./documents.js";
import { ProcurementId } from "./ids.js";
import { ChangeEvent, ProcedureCard, ProcedureStatus, SearchHit } from "./procurement.js";

export const InboxFixtureProcurement = z.object({
  title: z.string().min(1),
  status: ProcedureStatus,
  url: z.string().url(),
  sourceProcurementId: z.string().min(1),
});
export type InboxFixtureProcurement = z.infer<typeof InboxFixtureProcurement>;

export const InboxFixtureItem = z.object({
  procurement: InboxFixtureProcurement,
  change: ChangeEvent,
});
export type InboxFixtureItem = z.infer<typeof InboxFixtureItem>;

export const InboxFixture = z.object({
  items: z.array(InboxFixtureItem),
});
export type InboxFixture = z.infer<typeof InboxFixture>;

export const SpecialistInboxEntry = z.object({
  id: z.string().uuid(),
  procurementId: ProcurementId,
  title: z.string().min(1),
  status: ProcedureStatus,
  statusLabel: z.string().min(1),
  url: z.string().url(),
  sourceProcurementId: z.string().min(1),
  summary: z.string().min(1),
  detail: z.string().min(1),
  detectedOn: IsoDate,
  urgent: z.literal(true),
});
export type SpecialistInboxEntry = z.infer<typeof SpecialistInboxEntry>;

export const SpecialistInboxListResponse = z.object({
  items: z.array(SpecialistInboxEntry),
});
export type SpecialistInboxListResponse = z.infer<typeof SpecialistInboxListResponse>;

export const SpecialistChangeSlice = z.object({
  summary: z.string().min(1),
  detail: z.string().min(1),
  detectedOn: IsoDate,
  urgent: z.boolean(),
});
export type SpecialistChangeSlice = z.infer<typeof SpecialistChangeSlice>;

export const SpecialistPipelineAction = z.object({
  step: z.number().int().positive(),
  actor: z.string().min(1),
  status: z.enum(["done", "skipped"]),
  detail: z.string().min(1),
});
export type SpecialistPipelineAction = z.infer<typeof SpecialistPipelineAction>;

export const SpecialistDocumentExtraction = z.object({
  status: ExtractionStatus,
  kind: z.enum([
    "digital_text",
    "office_text",
    "ocr_scan",
    "skipped_project",
    "sparse_drawing",
    "empty",
    "non_pdf",
  ]),
  pageCount: z.number().int().nonnegative(),
  letterCount: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(1),
  ocrApplied: z.boolean(),
  textPreview: z.string(),
  pages: z.array(ExtractedPage).default([]),
  notes: z.array(z.string()).default([]),
});
export type SpecialistDocumentExtraction = z.infer<typeof SpecialistDocumentExtraction>;

export const SpecialistCaseDocument = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  downloadUrl: z.string().url().optional(),
  hash: Sha256.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: z.enum(["discovered", "hashed", "download_failed"]),
  note: z.string().optional(),
  extraction: SpecialistDocumentExtraction.optional(),
});
export type SpecialistCaseDocument = z.infer<typeof SpecialistCaseDocument>;

/** Specialist choice on a found procedure. Not a 0–100 score. */
export const SpecialistTriageKind = z.enum(["monitor", "participate", "reject"]);
export type SpecialistTriageKind = z.infer<typeof SpecialistTriageKind>;

export const SpecialistProcurementCard = z.object({
  id: ProcurementId,
  title: z.string().min(1),
  status: ProcedureStatus,
  statusLabel: z.string().min(1),
  url: z.string().url(),
  sourceProcurementId: z.string().min(1),
  latestChange: SpecialistChangeSlice.optional(),
  live: z.boolean().default(false),
  kindLabel: z.string().optional(),
  buyerName: z.string().optional(),
  amountLabel: z.string().optional(),
  documents: z.array(SpecialistCaseDocument).default([]),
  actions: z.array(SpecialistPipelineAction).default([]),
  termsDetail: z.string().optional(),
  paymentQuote: z.string().optional(),
  reportMarkdown: z.string().optional(),
  missing: z.array(z.string()).default([]),
  extractNotes: z.array(z.string()).default([]),
  extractPreview: z.string().optional(),
  /** Latest specialist choice; absent means the case is still waiting. */
  triage: SpecialistTriageKind.optional(),
});
export type SpecialistProcurementCard = z.infer<typeof SpecialistProcurementCard>;

export const SpecialistProcurementListResponse = z.object({
  items: z.array(SpecialistProcurementCard),
});
export type SpecialistProcurementListResponse = z.infer<typeof SpecialistProcurementListResponse>;

export const SpecialistSearchRequest = z.object({
  limit: z.number().int().positive().max(50).default(20),
});
export type SpecialistSearchRequest = z.infer<typeof SpecialistSearchRequest>;

export const SpecialistSearchResponse = z.object({
  profileName: z.string().min(1).default("Без названия"),
  relevantCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
  items: z.array(SpecialistProcurementCard),
});
export type SpecialistSearchResponse = z.infer<typeof SpecialistSearchResponse>;

export const SpecialistTriageDecision = z.object({
  sourceProcurementId: z.string().min(1),
  kind: SpecialistTriageKind,
  madeAt: IsoDateTime,
});
export type SpecialistTriageDecision = z.infer<typeof SpecialistTriageDecision>;

/**
 * Console working copy of a Domain Profile. Watch is off until the specialist
 * presses the dedicated button; saving looking-for text must not start discovery.
 * `keywords` are the platform queries: collected from `description` when empty,
 * otherwise the specialist's edited list.
 */
export const SpecialistWorkingProfile = z.object({
  id: z.string().uuid().default(() => crypto.randomUUID()),
  name: z.string().max(200).default(""),
  purpose: z.string().max(4000).default(""),
  description: z.string().max(4000).default(""),
  instructions: z.string().max(8000).default(""),
  keywords: z.array(z.string().min(1)).max(50).default([]),
  excludeKeywords: z.array(z.string().min(1)).max(50).default([]),
  watchNewProcurements: z.boolean().default(false),
});
export type SpecialistWorkingProfile = z.infer<typeof SpecialistWorkingProfile>;

export const SpecialistProfileWrite = SpecialistWorkingProfile.omit({
  id: true,
  watchNewProcurements: true,
});
export type SpecialistProfileWrite = z.infer<typeof SpecialistProfileWrite>;

export const SpecialistProfileListResponse = z.object({
  items: z.array(SpecialistWorkingProfile),
  activeProfileId: z.string().uuid(),
});
export type SpecialistProfileListResponse = z.infer<typeof SpecialistProfileListResponse>;

export const SpecialistWatchWrite = z.object({
  watchNewProcurements: z.boolean(),
});
export type SpecialistWatchWrite = z.infer<typeof SpecialistWatchWrite>;

export const SpecialistDecisionWrite = z.object({
  kind: SpecialistTriageKind,
});
export type SpecialistDecisionWrite = z.infer<typeof SpecialistDecisionWrite>;

export const SpecialistWorkspaceState = z.object({
  profiles: z.array(SpecialistWorkingProfile).min(1),
  activeProfileId: z.string().uuid(),
  decisions: z.array(SpecialistTriageDecision).default([]),
});
export type SpecialistWorkspaceState = z.infer<typeof SpecialistWorkspaceState>;

export const SpecialistDiscoveryResponse = z.object({
  ran: z.boolean(),
  reason: z.enum(["watch_off", "no_keywords", "ok"]),
  addedCount: z.number().int().nonnegative(),
  skippedDecidedCount: z.number().int().nonnegative(),
  items: z.array(SpecialistProcurementCard),
});
export type SpecialistDiscoveryResponse = z.infer<typeof SpecialistDiscoveryResponse>;

export const SpecialistLiveRun = z.object({
  capturedAt: IsoDateTime,
  profileName: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  procurementId: ProcurementId,
  hit: SearchHit,
  card: ProcedureCard,
  cardText: z.string().min(1),
  cardTextHash: Sha256,
  documents: z.array(SpecialistCaseDocument),
});
export type SpecialistLiveRun = z.infer<typeof SpecialistLiveRun>;
