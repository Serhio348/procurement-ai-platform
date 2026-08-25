import { z } from "zod";
import { Confidence, IsoDateTime, Money, Sha256 } from "./common.js";
import {
  ChangeEventId,
  DocumentId,
  DocumentVersionId,
  LotId,
  ProcurementId,
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
  "unknown",
]);
export type ProcedureStatus = z.infer<typeof ProcedureStatus>;

export const Organization = z.object({
  name: z.string().min(1),
  /** УНП in Belarus; other platforms may use a different registry code. */
  registrationNumber: z.string().optional(),
  address: z.string().optional(),
  contact: z.string().optional(),
});
export type Organization = z.infer<typeof Organization>;

export const Lot = z.object({
  id: LotId,
  procurementId: ProcurementId,
  number: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  startingPrice: Money.optional(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  deliveryPlace: z.string().optional(),
  deliveryTerm: z.string().optional(),
});
export type Lot = z.infer<typeof Lot>;

/**
 * The platform card as fetched by a source adapter. Almost everything is
 * optional: a scraped page is allowed to be incomplete, and the pipeline must
 * survive that rather than throw.
 */
export const ProcedureCard = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  url: z.string().url(),
  title: z.string().min(1),
  kind: ProcedureKind.default("other"),
  status: ProcedureStatus.default("unknown"),
  buyer: Organization.optional(),
  startingPrice: Money.optional(),
  publishedAt: IsoDateTime.optional(),
  bidsDeadlineAt: IsoDateTime.optional(),
  auctionAt: IsoDateTime.optional(),
  deliveryDeadline: z.string().optional(),
  /** Raw platform fields kept verbatim for provenance and later re-parsing. */
  rawFields: z.record(z.string(), z.string()).default({}),
  fetchedAt: IsoDateTime,
});
export type ProcedureCard = z.infer<typeof ProcedureCard>;

export const SearchQuery = z.object({
  sourceId: SourceId,
  keywords: z.array(z.string().min(1)).default([]),
  publishedFrom: IsoDateTime.optional(),
  publishedTo: IsoDateTime.optional(),
  kinds: z.array(ProcedureKind).default([]),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** Cheap listing row, before any expensive investigation. */
export const SearchHit = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  url: z.string().url(),
  title: z.string().min(1),
  buyerName: z.string().optional(),
  startingPrice: Money.optional(),
  publishedAt: IsoDateTime.optional(),
  bidsDeadlineAt: IsoDateTime.optional(),
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

export const ProcurementDocument = z.object({
  id: DocumentId,
  procurementId: ProcurementId,
  name: z.string().min(1),
  sourceUrl: z.string().url(),
  mimeType: z.string().min(1),
  currentVersionId: DocumentVersionId.optional(),
  status: DocumentStatus.default("discovered"),
  discoveredAt: IsoDateTime,
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

export const ChangeKind = z.enum([
  "status_changed",
  "price_changed",
  "deadline_changed",
  "document_added",
  "document_updated",
  "document_removed",
  "lot_changed",
  "other",
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const ChangeEvent = z.object({
  id: ChangeEventId,
  procurementId: ProcurementId,
  kind: ChangeKind,
  field: z.string().optional(),
  previous: z.string().nullable(),
  current: z.string().nullable(),
  documentId: DocumentId.optional(),
  previousVersionId: DocumentVersionId.optional(),
  currentVersionId: DocumentVersionId.optional(),
  detectedAt: IsoDateTime,
  urgent: z.boolean().default(false),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

export const InvestigationStage = z.enum([
  "discovered",
  "classified",
  "card_fetched",
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
