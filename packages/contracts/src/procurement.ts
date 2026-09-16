import { z } from "zod";
import {
  Confidence,
  IsoDateTime,
  Money,
  PlatformAmount,
  PlatformInstant,
  Sha256,
} from "./common.js";
import {
  ChangeEventId,
  ClarificationId,
  ContactId,
  DocumentId,
  DocumentVersionId,
  LotId,
  PartyId,
  PositionId,
  ProcurementId,
  RawArtifactId,
  SourceId,
  SourceProcurementId,
} from "./ids.js";

export const ProcedureKind = z.enum([
  "electronic_auction",
  "request_for_quotations",
  "open_tender",
  "competitive_negotiation",
  "single_source",
  "other",
]);
export type ProcedureKind = z.infer<typeof ProcedureKind>;

export const ProcedureStatus = z.enum([
  "announced",
  "accepting_bids",
  "bidding_closed",
  "auction_in_progress",
  "under_review",
  "completed",
  "cancelled",
  /** The source declared the procedure failed (e.g. no valid bids). */
  "failed",
  "unknown",
]);
export type ProcedureStatus = z.infer<typeof ProcedureStatus>;

/** URL family on goszakupki.by and similar sites. Other sources use `other`. */
export const PageFamily = z.enum(["auction", "marketing", "request", "etrade", "other"]);
export type PageFamily = z.infer<typeof PageFamily>;

export const ExternalIdKind = z.enum(["internal", "auc", "gias", "tenders_is", "url", "other"]);
export type ExternalIdKind = z.infer<typeof ExternalIdKind>;

export const ExternalIdentifier = z.object({
  kind: ExternalIdKind,
  value: z.string().min(1),
});
export type ExternalIdentifier = z.infer<typeof ExternalIdentifier>;

export const PartyRole = z.enum(["buyer", "procuring_organization", "organizer", "operator"]);
export type PartyRole = z.infer<typeof PartyRole>;

export const PartyContact = z.object({
  id: ContactId.optional(),
  name: z.string().optional(),
  role: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  /** Original contact line as printed on the card. */
  raw: z.string().min(1),
});
export type PartyContact = z.infer<typeof PartyContact>;

export const Party = z.object({
  id: PartyId.optional(),
  role: PartyRole,
  name: z.string().min(1),
  registrationNumber: z.string().optional(),
  address: z.string().optional(),
  contacts: z.array(PartyContact).default([]),
});
export type Party = z.infer<typeof Party>;

export const Organization = z.object({
  name: z.string().min(1),
  /** УНП in Belarus; other platforms may use a different registry code. */
  registrationNumber: z.string().optional(),
  address: z.string().optional(),
  contact: z.string().optional(),
});
export type Organization = z.infer<typeof Organization>;

export const SourceLotPosition = z.object({
  externalNumber: z.string().optional(),
  title: z.string().min(1),
  quantity: z.number().nonnegative().optional(),
  unit: z.string().optional(),
});
export type SourceLotPosition = z.infer<typeof SourceLotPosition>;

export const LotPosition = SourceLotPosition.extend({
  id: PositionId,
  lotId: LotId,
});
export type LotPosition = z.infer<typeof LotPosition>;

export const SourceLot = z.object({
  number: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.string().optional(),
  startingPrice: Money.optional(),
  amount: PlatformAmount.optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  deliveryPlace: z.string().optional(),
  deliveryTerm: z.string().optional(),
  funding: z.string().optional(),
  paymentTermsRaw: z.string().optional(),
  bidSecurity: z.string().optional(),
  contractSecurity: z.string().optional(),
  okrbCode: z.string().optional(),
  positions: z.array(SourceLotPosition).default([]),
});
export type SourceLot = z.infer<typeof SourceLot>;

export const Lot = SourceLot.omit({ positions: true }).extend({
  id: LotId,
  procurementId: ProcurementId,
  positions: z.array(LotPosition).default([]),
});
export type Lot = z.infer<typeof Lot>;

/**
 * Name and URL as printed in the card's document block. No download, no
 * Yandex expansion: enough to see that a file appeared or vanished.
 */
export const ListedSourceAttachment = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
});
export type ListedSourceAttachment = z.infer<typeof ListedSourceAttachment>;

/**
 * The platform card as fetched by a source adapter. Almost everything is
 * optional: a scraped page is allowed to be incomplete, and the pipeline must
 * survive that rather than throw.
 */
export const ProcedureCard = z.object({
  listedDocuments: z.array(ListedSourceAttachment).default([]),
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  externalIds: z.array(ExternalIdentifier).default([]),
  url: z.string().url(),
  title: z.string().min(1),
  pageFamily: PageFamily.default("other"),
  kind: ProcedureKind.default("other"),
  status: ProcedureStatus.default("unknown"),
  /** Verbatim status label from the page. */
  sourceStatus: z.string().optional(),
  parties: z.array(Party).default([]),
  buyer: Organization.optional(),
  startingPrice: Money.optional(),
  amount: PlatformAmount.optional(),
  publishedAt: PlatformInstant.optional(),
  bidsDeadline: PlatformInstant.optional(),
  auctionAt: PlatformInstant.optional(),
  deliveryDeadline: z.string().optional(),
  /**
   * Why a single-source purchase was allowed, verbatim from the card
   * ("7. Признание процедуры государственной закупки несостоявшейся").
   * Only single-source cards carry it.
   */
  singleSourceBasis: z.string().optional(),
  /** Source number of the failed procedure this single-source purchase replaces. */
  precedingProcedureNumber: z.string().optional(),
  lots: z.array(SourceLot).default([]),
  /** Raw platform fields kept verbatim for provenance and later re-parsing. */
  rawFields: z.record(z.string(), z.string()).default({}),
  fetchedAt: IsoDateTime,
});
export type ProcedureCard = z.infer<typeof ProcedureCard>;

export const SearchQuery = z.object({
  sourceId: SourceId,
  keywords: z.array(z.string().min(1)).default([]),
  excludeKeywords: z.array(z.string().min(1)).default([]),
  /** Buyer / organizer UNP, passed to the source when supported. */
  buyerUnp: z.string().max(32).default(""),
  /** Buyer / organizer name substring. */
  buyerText: z.string().max(300).default(""),
  /** Procedure number / lot number prefix. */
  procurementNumber: z.string().max(64).default(""),
  /** Approximate price range in source currency. */
  priceFrom: z.number().nonnegative().optional(),
  priceTo: z.number().nonnegative().optional(),
  publishedFrom: IsoDateTime.optional(),
  publishedTo: IsoDateTime.optional(),
  /** Bids-acceptance deadline range. */
  requestEndFrom: IsoDateTime.optional(),
  requestEndTo: IsoDateTime.optional(),
  /** Auction / tender date range. */
  auctionFrom: IsoDateTime.optional(),
  auctionTo: IsoDateTime.optional(),
  /** Source-specific region codes. */
  regionIds: z.array(z.string().min(1)).default([]),
  /** Source-specific procedure type codes. */
  typeIds: z.array(z.string().min(1)).default([]),
  /** Source-specific status codes already known to the adapter. */
  statusIds: z.array(z.string().min(1)).default([]),
  /**
   * Profile status checkboxes. The source adapter maps them to its own
   * `TendersSearch[status][]` (or equivalent) codes. Empty means no
   * site-side status filter.
   */
  statuses: z.array(ProcedureStatus).default([]),
  kinds: z.array(ProcedureKind).default([]),
  limit: z.number().int().positive().max(500).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** Cheap listing row, before any expensive investigation. */
export const SearchHit = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  url: z.string().url(),
  title: z.string().min(1),
  pageFamily: PageFamily.optional(),
  /** Procedure kind when the listing row exposed one. */
  kind: ProcedureKind.optional(),
  /** Normalized status when the listing row exposed one. */
  status: ProcedureStatus.optional(),
  sourceStatus: z.string().optional(),
  buyerName: z.string().optional(),
  startingPrice: Money.optional(),
  amount: PlatformAmount.optional(),
  publishedAt: PlatformInstant.optional(),
  bidsDeadline: PlatformInstant.optional(),
  /**
   * Profile phrases whose platform query returned this row. A row found by
   * several phrases is one candidate that lists them all. Diagnostics and
   * later scoring only; never a relevance verdict on its own.
   */
  matchedSearchTerms: z.array(z.string().min(1)).optional(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const DocumentStatus = z.enum([
  "discovered",
  "downloading",
  "downloaded",
  "extracting",
  "extracted",
  "ocr_required",
  "failed",
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentLifecycle = z.enum(["active", "deleted"]);
export type DocumentLifecycle = z.infer<typeof DocumentLifecycle>;

export const SourceDocument = z.object({
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  mimeType: z.string().min(1),
  /**
   * Positional file key on the source page. Locator only - never used as a
   * stable document identity.
   */
  sourceFileKey: z.string().optional(),
  metadataUrl: z.string().url().optional(),
  downloadUrl: z.string().url().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  lifecycle: DocumentLifecycle.default("active"),
  discoveredAt: IsoDateTime,
});
export type SourceDocument = z.infer<typeof SourceDocument>;

export const ProcurementDocument = SourceDocument.extend({
  id: DocumentId,
  procurementId: ProcurementId,
  currentVersionId: DocumentVersionId.optional(),
  status: DocumentStatus.default("discovered"),
});
export type ProcurementDocument = z.infer<typeof ProcurementDocument>;

/**
 * Documents are versioned by content hash. A changed hash creates a new
 * version and keeps the old one, which is what change detection relies on.
 */
export const DocumentVersion = z.object({
  id: DocumentVersionId,
  documentId: DocumentId,
  version: z.number().int().positive(),
  hash: Sha256,
  sizeBytes: z.number().int().nonnegative(),
  downloadedAt: IsoDateTime,
  /** Content-addressed key in object storage: `blobs/{sha256}`. */
  storageKey: z.string().min(1),
  pageCount: z.number().int().positive().optional(),
  extractedTextLength: z.number().int().nonnegative().optional(),
  ocrApplied: z.boolean().default(false),
});
export type DocumentVersion = z.infer<typeof DocumentVersion>;

export const RawArtifactKind = z.enum(["html", "json", "binary_meta"]);
export type RawArtifactKind = z.infer<typeof RawArtifactKind>;

export const RawArtifact = z.object({
  id: RawArtifactId,
  procurementId: ProcurementId,
  kind: RawArtifactKind,
  hash: Sha256,
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  pageFamily: PageFamily.optional(),
  capturedAt: IsoDateTime,
});
export type RawArtifact = z.infer<typeof RawArtifact>;

export const SourceClarification = z.object({
  question: z.string().min(1),
  answer: z.string().optional(),
  askedAt: IsoDateTime.optional(),
  answeredAt: IsoDateTime.optional(),
  sourceUrl: z.string().url().optional(),
});
export type SourceClarification = z.infer<typeof SourceClarification>;

export const Clarification = SourceClarification.extend({
  id: ClarificationId,
  procurementId: ProcurementId,
});
export type Clarification = z.infer<typeof Clarification>;

export const ChangeKind = z.enum([
  "procedure_found",
  "procedure_candidate",
  "status_changed",
  "price_changed",
  "deadline_changed",
  "document_added",
  "document_updated",
  "document_removed",
  "lot_changed",
  "clarification_added",
  "clarification_answered",
  "other",
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

const ChangeDetails = z.object({
  kind: ChangeKind,
  field: z.string().optional(),
  previous: z.string().nullable(),
  current: z.string().nullable(),
  detectedAt: IsoDateTime,
  urgent: z.boolean().default(false),
});

export const SourceChange = ChangeDetails.extend({
  sourceFileKey: z.string().optional(),
});
export type SourceChange = z.infer<typeof SourceChange>;

export const ChangeEvent = ChangeDetails.extend({
  id: ChangeEventId,
  procurementId: ProcurementId,
  documentId: DocumentId.optional(),
  previousVersionId: DocumentVersionId.optional(),
  currentVersionId: DocumentVersionId.optional(),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

export const InvestigationStage = z.enum([
  "discovered",
  "classified",
  "card_fetched",
  "waiting_human",
  "inactive",
  "documents_downloaded",
  "documents_extracted",
  "commercial_analysed",
  "scored",
  "reported",
  "monitoring",
  "discarded",
]);
export type InvestigationStage = z.infer<typeof InvestigationStage>;

/**
 * Header of the procurement case aggregate. Facts, risks, scores and change
 * events reference it by id rather than being nested, so the object stays
 * cheap to load.
 */
export const ProcurementCaseHeader = z.object({
  id: ProcurementId,
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  url: z.string().url(),
  year: z.number().int().min(2000).max(2100),
  title: z.string().min(1),
  kind: ProcedureKind,
  status: ProcedureStatus,
  stage: InvestigationStage,
  relevance: Confidence.optional(),
  /** Why the case was kept or discarded, in plain language. */
  relevanceReason: z.string().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProcurementCaseHeader = z.infer<typeof ProcurementCaseHeader>;
