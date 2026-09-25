import { z } from "zod";
import { CommercialFactKey } from "./commercial-terms.js";
import { IsoDate, IsoDateTime, Sha256 } from "./common.js";
import { ExtractedPage, ExtractionStatus } from "./documents.js";
import { ProcurementId } from "./ids.js";
import {
  ChangeEvent,
  ChangeKind,
  ListedSourceAttachment,
  ProcedureCard,
  ProcedureStatus,
  SearchHit,
} from "./procurement.js";

function blankToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  return value;
}

function asOptionalText(value: unknown): unknown {
  const blank = blankToUndefined(value);
  return typeof blank === "string" ? blank.trim() : blank;
}

function asOptionalIsoDate(value: unknown): unknown {
  const blank = blankToUndefined(value);
  if (typeof blank === "string" && /^\d{4}-\d{2}-\d{2}/.test(blank)) return blank.slice(0, 10);
  return blank;
}

function asOptionalPrice(value: unknown): unknown {
  const blank = blankToUndefined(value);
  if (typeof blank === "number") return Number.isFinite(blank) ? blank : undefined;
  if (typeof blank === "string") {
    const parsed = Number(blank.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return blank;
}

const OptionalFilterText = (max: number) =>
  z.preprocess(asOptionalText, z.string().max(max).optional());
const OptionalFilterDate = z.preprocess(asOptionalIsoDate, IsoDate.optional());
const OptionalFilterPrice = z.preprocess(
  asOptionalPrice,
  z.number().nonnegative().finite().optional(),
);

export const SpecialistSearchFilters = z.object({
  /** Site-side: buyer / organizer UNP. */
  buyerUnp: OptionalFilterText(32),
  /** Site-side: buyer / organizer name substring. */
  buyerText: OptionalFilterText(300),
  /** Site-side: procedure number or lot number. */
  procurementNumber: OptionalFilterText(64),
  /** Site-side: approximate price range in BYN, inclusive. */
  priceFrom: OptionalFilterPrice,
  priceTo: OptionalFilterPrice,
  /** Site-side: invitation posting dates. */
  publishedFrom: OptionalFilterDate,
  publishedTo: OptionalFilterDate,
  /** Site-side: bids acceptance deadline. */
  requestEndFrom: OptionalFilterDate,
  requestEndTo: OptionalFilterDate,
  /** Site-side: auction date. */
  auctionFrom: OptionalFilterDate,
  auctionTo: OptionalFilterDate,
  /** Site-side goszakupki.by procedure type codes. */
  typeIds: z.array(z.string().min(1)).optional(),
  /** Site-side goszakupki.by region codes. */
  regionIds: z.array(z.string().min(1)).optional(),
  /** Site-side goszakupki.by status codes. Empty means no site-side status filter. */
  statusIds: z.array(z.string().min(1)).optional(),
});
export type SpecialistSearchFilters = z.infer<typeof SpecialistSearchFilters>;

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

export const SpecialistInboxTopic = z.enum(["new_found", "documents", "card_update", "review"]);
export type SpecialistInboxTopic = z.infer<typeof SpecialistInboxTopic>;

export const SpecialistInboxAction = z.enum(["open", "refresh", "documents", "dismiss"]);
export type SpecialistInboxAction = z.infer<typeof SpecialistInboxAction>;

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
  urgent: z.boolean(),
  kind: ChangeKind,
  topic: SpecialistInboxTopic,
  topicLabel: z.string().min(1),
  /** Directions whose search produced this case — explains a review row. */
  profileNames: z.array(z.string().min(1)).default([]),
  /** Code-written why for the score — what the specialist should verify. */
  reviewReason: z.string().optional(),
});
export type SpecialistInboxEntry = z.infer<typeof SpecialistInboxEntry>;

export const SpecialistInboxListResponse = z.object({
  items: z.array(SpecialistInboxEntry),
});
export type SpecialistInboxListResponse = z.infer<typeof SpecialistInboxListResponse>;

export const SpecialistInboxDismissAllResponse = z.object({
  items: z.array(SpecialistInboxEntry),
  /** How many open rows the clear marked as read. */
  dismissed: z.number().int().min(0),
});
export type SpecialistInboxDismissAllResponse = z.infer<
  typeof SpecialistInboxDismissAllResponse
>;

/** Telegram link of the signed-in specialist — set up from the console. */
export const SpecialistTelegramStatus = z.object({
  /** Bot is configured on the server; without it linking is impossible. */
  available: z.boolean(),
  linked: z.boolean(),
  username: z.string().optional(),
  mode: z.enum(["all", "urgent"]).optional(),
});
export type SpecialistTelegramStatus = z.infer<typeof SpecialistTelegramStatus>;

export const SpecialistTelegramLinkResponse = z.object({
  code: z.string().min(1),
  /** t.me deep link with the one-time code; absent until the bot name is known. */
  url: z.string().url().optional(),
  expiresInSec: z.number().int().min(1),
});
export type SpecialistTelegramLinkResponse = z.infer<typeof SpecialistTelegramLinkResponse>;

export const SpecialistTelegramModeWrite = z.object({
  mode: z.enum(["all", "urgent"]),
});
export type SpecialistTelegramModeWrite = z.infer<typeof SpecialistTelegramModeWrite>;

export const SpecialistInboxResolveWrite = z.object({
  action: SpecialistInboxAction,
});
export type SpecialistInboxResolveWrite = z.infer<typeof SpecialistInboxResolveWrite>;

export const SpecialistInboxDocumentLink = z.object({
  name: z.string().min(1),
  url: z.string().url(),
});
export type SpecialistInboxDocumentLink = z.infer<typeof SpecialistInboxDocumentLink>;

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
    "archive",
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

/**
 * One commercial condition the specialist can check: the wording as printed,
 * the file it came from and the page. Written only for claims that passed the
 * provenance gate, so a line without a quote cannot reach the console.
 */
export const SpecialistTermsEvidence = z.object({
  key: CommercialFactKey,
  label: z.string().min(1),
  value: z.string().min(1),
  quote: z.string().min(1).max(600),
  documentName: z.string().min(1),
  page: z.number().int().positive(),
  /** "rule": regex over the page text. "model": the model proposed it, code verified the quote. */
  foundBy: z.enum(["rule", "model"]),
});
export type SpecialistTermsEvidence = z.infer<typeof SpecialistTermsEvidence>;

/** Specialist choice on a found procedure. Not a 0–100 score. */
export const SpecialistTriageKind = z.enum(["monitor", "participate", "reject"]);
export type SpecialistTriageKind = z.infer<typeof SpecialistTriageKind>;

/**
 * What the source said about a decided case the last time the platform read
 * it. `priceKey` is the normalized figure used for comparison; `priceLabel` is
 * the wording as printed, shown to the specialist. Comparing labels directly
 * would turn a reformatted page into a fake price change.
 */
export const SpecialistCardSnapshot = z.object({
  capturedAt: IsoDateTime,
  status: ProcedureStatus,
  priceKey: z.string().min(1).optional(),
  priceLabel: z.string().min(1).optional(),
  /** Bids deadline as published: a plain date or an instant, verbatim. */
  bidsDeadline: z.string().min(1).optional(),
  /**
   * Attachments as listed on the page. Absent on snapshots taken before
   * document watch: the next pass records the list and does not alert.
   */
  documents: z.array(ListedSourceAttachment).optional(),
});
export type SpecialistCardSnapshot = z.infer<typeof SpecialistCardSnapshot>;

/**
 * What one profile's search decided about a card. Kept per profile so a
 * second direction's run cannot overwrite the first one's answer (R04).
 */
export const SpecialistCardAssessment = z.object({
  verdict: z.enum(["match", "review"]),
  score: z.number().int().min(0).max(100).optional(),
  reason: z.string().max(500).optional(),
  evaluatedAt: IsoDateTime,
});
export type SpecialistCardAssessment = z.infer<typeof SpecialistCardAssessment>;

export const SpecialistProcurementCard = z.object({
  id: ProcurementId,
  /**
   * Shared public procedure row. Absent on records created before personal
   * workspaces: then `id` was also the canonical procurement id.
   */
  canonicalProcurementId: ProcurementId.optional(),
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
  termsEvidence: z.array(SpecialistTermsEvidence).default([]),
  paymentQuote: z.string().optional(),
  reportMarkdown: z.string().optional(),
  missing: z.array(z.string()).default([]),
  extractNotes: z.array(z.string()).default([]),
  extractPreview: z.string().optional(),
  /** Latest specialist choice; absent means the case is still waiting. */
  triage: SpecialistTriageKind.optional(),
  /** Profiles that found this case. Empty: not yet tied to a direction. */
  profileIds: z.array(z.string().uuid()).default([]),
  /**
   * How the case reached the console. "match": a confident keyword hit, shown
   * in the list. "review": a weak or keyword-less hit that waits in the inbox
   * and stays out of the list until a specialist opens or decides it.
   */
  foundAs: z.enum(["match", "review"]).optional(),
  /**
   * 0–100 listing score from code, never from a model. Absent on cards found
   * before intent scoring existed.
   */
  relevanceScore: z.number().int().min(0).max(100).optional(),
  /** Plain-language why the score came out this way. Written by code. */
  relevanceReason: z.string().max(500).optional(),
  /**
   * Per-profile verdicts: profileId → what that direction's search decided.
   * The top-level foundAs/score/reason are a derived view over this map
   * (a match from any profile wins); a profile-scoped view projects its own
   * entry so one direction cannot overwrite another's answer (R04).
   */
  assessments: z.record(z.string().uuid(), SpecialistCardAssessment).default({}),
  /**
   * The specialist moved the case to the archive: done participating, kept for
   * the record. Archived cases stay listed but leave "Мои закупки" and stop
   * being re-read by monitoring.
   */
  archived: z.boolean().default(false),
  /** When a search last returned this case. Undecided cases not seen for a while are pruned. */
  lastSeenAt: IsoDateTime.optional(),
  /**
   * Last source reading of a case the specialist decided to follow. Present
   * only after the first monitoring pass; absent means there is nothing to
   * compare against yet, so the next pass only records, never alerts.
   */
  watchSnapshot: SpecialistCardSnapshot.optional(),
  /**
   * Full platform card stored when the specialist takes the case. "Мои закупки"
   * renders this instead of hitting the source again. Absent on listing-only
   * cases and on records decided before this field existed.
   */
  sourceCard: ProcedureCard.optional(),
  /**
   * A background document job for this case was persisted in flight. The flag
   * survives a restart: on the next cabinet open the job resumes — already
   * hashed files are the checkpoint and are skipped (R16). Absent when no
   * job is running.
   */
  ingesting: z.enum(["ingest", "reindex"]).optional(),
});
export type SpecialistProcurementCard = z.infer<typeof SpecialistProcurementCard>;
export type SpecialistFoundAs = NonNullable<SpecialistProcurementCard["foundAs"]>;

export const SpecialistInboxResolveResponse = z.object({
  items: z.array(SpecialistInboxEntry),
  card: SpecialistProcurementCard.optional(),
  documents: z.array(SpecialistInboxDocumentLink).default([]),
});
export type SpecialistInboxResolveResponse = z.infer<typeof SpecialistInboxResolveResponse>;

export const SpecialistProcurementListTab = z.enum([
  "listed",
  "search",
  "all",
  "monitor",
  "participate",
  "archive",
  "trash",
]);
export type SpecialistProcurementListTab = z.infer<typeof SpecialistProcurementListTab>;

export const SpecialistProcurementListQuery = z.object({
  tab: SpecialistProcurementListTab.default("listed"),
  /**
   * Required when tab === "search": a search queue belongs to the
   * profile that found it, never to whichever profile is active.
   */
  profileId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});
export type SpecialistProcurementListQuery = z.infer<typeof SpecialistProcurementListQuery>;

export const SpecialistProcurementListResponse = z.object({
  items: z.array(SpecialistProcurementCard),
  total: z.number().int().nonnegative().default(0),
  tab: SpecialistProcurementListTab.default("listed"),
  hasMore: z.boolean().default(false),
});
export type SpecialistProcurementListResponse = z.infer<typeof SpecialistProcurementListResponse>;

export const SpecialistSearchRequest = z.object({
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});
export type SpecialistSearchRequest = z.infer<typeof SpecialistSearchRequest>;

/**
 * A button-search names the profile it runs for. The active profile is
 * shared mutable state and must not double as the request's subject.
 */
export const SpecialistProfileSearchRequest = SpecialistSearchRequest.extend({
  profileId: z.string().uuid(),
});
export type SpecialistProfileSearchRequest = z.infer<typeof SpecialistProfileSearchRequest>;

/** Search progress is polled for a named profile, not the active one. */
export const SpecialistSearchProgressQuery = z.object({
  profileId: z.string().uuid(),
});
export type SpecialistSearchProgressQuery = z.infer<typeof SpecialistSearchProgressQuery>;

export const SpecialistSearchRunStatus = z.enum([
  "retrieving",
  "scoring",
  "done",
  "failed",
  /** The process stopped mid-run; the stored snapshot survives a restart (R16). */
  "interrupted",
  /** The specialist stopped the run; cards already scored stay found (R35). */
  "cancelled",
]);
export type SpecialistSearchRunStatus = z.infer<typeof SpecialistSearchRunStatus>;

/**
 * Background card scoring for one profile search. Listing never writes a
 * verdict; scoredCount moves as procurement.get + intent score finish.
 */
export const SpecialistSearchRun = z.object({
  profileId: z.string().uuid(),
  /**
   * Identity of this run. A newer search for the same profile supersedes
   * the older one; progress writes carrying a stale runId are dropped so
   * concurrent runs cannot interleave into each other's queue (R15).
   * Absent on synthetic "idle" snapshots.
   */
  runId: z.string().uuid().optional(),
  profileName: z.string().min(1),
  status: SpecialistSearchRunStatus,
  retrievedCount: z.number().int().nonnegative(),
  scoredCount: z.number().int().nonnegative(),
  matchCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
  reviewCount: z.number().int().nonnegative(),
  /** Listing rows never opened. Not part of discardedCount. */
  listingDiscardedCount: z.number().int().nonnegative().default(0),
  skipped: z
    .array(
      z.object({
        sourceProcurementId: z.string().min(1),
        title: z.string(),
        reason: z.string().min(1),
        stage: z.enum(["listing", "card"]),
      }),
    )
    .default([]),
});
export type SpecialistSearchRun = z.infer<typeof SpecialistSearchRun>;

export const SpecialistSearchResponse = z.object({
  profileName: z.string().min(1).default("Без названия"),
  relevantCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
  /** Hits sent to the inbox for a human check instead of being dropped. */
  ambiguousCount: z.number().int().nonnegative().default(0),
  /** True when the source returned a full page — more results may follow. */
  hasMore: z.boolean().default(false),
  items: z.array(SpecialistProcurementCard),
  run: SpecialistSearchRun.optional(),
});
export type SpecialistSearchResponse = z.infer<typeof SpecialistSearchResponse>;

export const SpecialistTriageDecision = z.object({
  sourceProcurementId: z.string().min(1),
  kind: SpecialistTriageKind,
  madeAt: IsoDateTime,
});
export type SpecialistTriageDecision = z.infer<typeof SpecialistTriageDecision>;

/**
 * Console working copy of a profile. Watch is off until the specialist
 * presses the dedicated button. `keywords` are the platform search phrases.
 */
export const SpecialistWorkingProfile = z.object({
  id: z.string().uuid().default(() => crypto.randomUUID()),
  name: z.string().max(200).default(""),
  purpose: z.string().max(4000).default(""),
  description: z.string().max(4000).default(""),
  keywords: z.array(z.string().min(1)).max(50).default([]),
  excludeKeywords: z.array(z.string().min(1)).max(50).default([]),
  /** Procedure statuses this profile collects. Empty array means no status filter. */
  statuses: z.array(ProcedureStatus).default(["accepting_bids"]),
  /** Drop every single-source purchase; the kind is visible in the listing row. */
  excludeSingleSource: z.boolean().default(false),
  /** Site-side filters sent with the search query. */
  filters: SpecialistSearchFilters.default({}),
  watchNewProcurements: z.boolean().default(false),
  /**
   * When background discovery last finished for this profile. The next pass
   * asks the source only for procedures posted since then (minus a margin), so
   * the page limit stops hiding older-but-new procedures. Reset when the
   * search phrases change.
   */
  lastDiscoveryAt: IsoDateTime.optional(),
});
export type SpecialistWorkingProfile = z.infer<typeof SpecialistWorkingProfile>;

export const SpecialistProfileWrite = SpecialistWorkingProfile.omit({
  id: true,
  watchNewProcurements: true,
  lastDiscoveryAt: true,
});
export type SpecialistProfileWrite = z.infer<typeof SpecialistProfileWrite>;

/**
 * AI-assisted profile drafting: the fields the model is allowed to propose.
 * Filters and description stay manual; watch is never enabled by a draft.
 */
export const SpecialistProfileDraft = SpecialistProfileWrite.pick({
  name: true,
  purpose: true,
  keywords: true,
  excludeKeywords: true,
  statuses: true,
  excludeSingleSource: true,
});
export type SpecialistProfileDraft = z.infer<typeof SpecialistProfileDraft>;

export const SpecialistProfileSuggestRequest = z.object({
  text: z.string().trim().min(3).max(4000),
});
export type SpecialistProfileSuggestRequest = z.infer<typeof SpecialistProfileSuggestRequest>;

export const SpecialistProfileSuggestResponse = z.object({
  draft: SpecialistProfileDraft,
  /** One paragraph in Russian: why these words and what the probe found. */
  explanation: z.string().max(4000).default(""),
  /** Real listing titles the draft was checked against — shown for trust. */
  sampledTitles: z.array(z.string().min(1)).max(60).default([]),
  /** false → the source probe did not run; the draft came from the text alone. */
  grounded: z.boolean().default(false),
});
export type SpecialistProfileSuggestResponse = z.infer<typeof SpecialistProfileSuggestResponse>;

/**
 * A hit the review step (card or model) confidently called irrelevant for a
 * profile. Remembered so the next pass does not spend a card fetch and a model
 * call on the same procedure again. Not a specialist decision.
 */
export const SpecialistReviewVerdict = z.object({
  profileId: z.string().uuid(),
  sourceProcurementId: z.string().min(1),
  decidedAt: IsoDateTime,
  /** Automatic classifier revision; old revisions must be re-evaluated. */
  algorithmVersion: z.string().min(1).default("legacy"),
});
export type SpecialistReviewVerdict = z.infer<typeof SpecialistReviewVerdict>;

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

/** Moves a decided case to or out of the archive without losing its triage. */
export const SpecialistArchiveWrite = z.object({
  archived: z.boolean(),
});
export type SpecialistArchiveWrite = z.infer<typeof SpecialistArchiveWrite>;

export const SpecialistIngestFileState = z.enum([
  "pending",
  "downloading",
  "indexing",
  "read",
  "skipped",
  "failed",
]);
export type SpecialistIngestFileState = z.infer<typeof SpecialistIngestFileState>;

export const SpecialistIngestFileProgress = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  state: SpecialistIngestFileState,
  percent: z.number().int().min(0).max(100),
  hash: Sha256.optional(),
});
export type SpecialistIngestFileProgress = z.infer<typeof SpecialistIngestFileProgress>;

/** Live participate ingest. Percent is files weighted, not a 0–100 score. */
export const SpecialistIngestProgress = z.object({
  procurementId: ProcurementId,
  phase: z.enum(["idle", "listing", "downloading", "indexing", "done", "failed"]),
  total: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  readCount: z.number().int().nonnegative(),
  percent: z.number().int().min(0).max(100),
  currentName: z.string().optional(),
  files: z.array(SpecialistIngestFileProgress).default([]),
});
export type SpecialistIngestProgress = z.infer<typeof SpecialistIngestProgress>;

export const SpecialistWorkspaceState = z.object({
  profiles: z.array(SpecialistWorkingProfile).min(1),
  activeProfileId: z.string().uuid(),
  decisions: z.array(SpecialistTriageDecision).default([]),
  dismissedInboxIds: z.array(z.string().uuid()).default([]),
  reviewedIrrelevant: z.array(SpecialistReviewVerdict).default([]),
  /** Source ids of cases the specialist moved to the archive. */
  archivedSourceIds: z.array(z.string().min(1)).default([]),
  /**
   * Last button-search matches per profile, in list order. «Закупки» shows
   * this queue, not every case ever stored in the cabinet.
   */
  searchIdsByProfile: z.record(z.string().uuid(), z.array(z.string().uuid())).default({}),
  /**
   * Latest search run per profile, persisted with the workspace so a restart
   * does not lose it. A run stored mid-flight is marked "interrupted" on the
   * next cabinet open instead of silently vanishing (R16).
   */
  searchRuns: z.record(z.string().uuid(), SpecialistSearchRun).default({}),
});
export type SpecialistWorkspaceState = z.infer<typeof SpecialistWorkspaceState>;

export const SpecialistDiscoveryResponse = z.object({
  ran: z.boolean(),
  reason: z.enum(["watch_off", "no_keywords", "ok", "already_running", "cooldown"]),
  addedCount: z.number().int().nonnegative(),
  skippedDecidedCount: z.number().int().nonnegative(),
  /** Decided cases re-read from the source during this pass. */
  monitoredCount: z.number().int().nonnegative().default(0),
  /** Decided cases whose price, status or deadline moved. */
  changedCount: z.number().int().nonnegative().default(0),
  items: z.array(SpecialistProcurementCard),
});
export type SpecialistDiscoveryResponse = z.infer<typeof SpecialistDiscoveryResponse>;

export const SpecialistDiscoveryHealth = z.object({
  isRunning: z.boolean(),
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
  /** Last pass that actually completed against the source (R42). */
  lastSuccessAt: IsoDateTime.optional(),
  lastErrorAt: IsoDateTime.optional(),
  cooldownUntil: IsoDateTime.optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  circuitOpen: z.boolean(),
  watchingCount: z.number().int().nonnegative(),
  intervalMs: z.number().int().nonnegative(),
  lastAddedCount: z.number().int().nonnegative().optional(),
  lastSkippedCount: z.number().int().nonnegative().optional(),
});
export type SpecialistDiscoveryHealth = z.infer<typeof SpecialistDiscoveryHealth>;

export const SpecialistDiscoveryHealthResponse = z.object({
  health: SpecialistDiscoveryHealth,
});
export type SpecialistDiscoveryHealthResponse = z.infer<typeof SpecialistDiscoveryHealthResponse>;

/**
 * Readiness report (R42). Liveness stays at GET /api/live ({ok:true}) — the
 * process answers while it runs. /api/health answers whether the service can
 * actually serve: PostgreSQL pinged, source lane connected, models present.
 * `degraded` holds human-readable component names; no secrets, no env values.
 */
export const SpecialistServiceHealth = z.object({
  ok: z.literal(true),
  ready: z.boolean(),
  /** Deployed revision — verifies which build actually runs (APP_BUILD_SHA). */
  sha: z.string().min(1).optional(),
  mode: z.enum(["live", "fixture"]),
  uptimeSec: z.number().nonnegative(),
  components: z.object({
    postgres: z.enum(["ok", "failed", "off"]),
    source: z.enum(["live", "fixture", "off"]),
    objectStore: z.string().min(1),
    models: z.object({
      searchIntent: z.boolean(),
      classifier: z.boolean(),
      commercialReader: z.boolean(),
    }),
    mail: z.boolean(),
    telegram: z.boolean(),
  }),
  /** Human-readable names of missing/failed capabilities. */
  degraded: z.array(z.string().min(1)),
  discovery: SpecialistDiscoveryHealth.optional(),
});
export type SpecialistServiceHealth = z.infer<typeof SpecialistServiceHealth>;

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
