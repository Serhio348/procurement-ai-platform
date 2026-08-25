import { z } from "zod";
import { DocumentId, DocumentVersionId, EvidenceId, FactId, ProcurementId } from "./ids.js";

export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Model-reported certainty. Never used directly as a score. */
export const Confidence = z.number().min(0).max(1);
export type Confidence = z.infer<typeof Confidence>;

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.object({
  amount: z.number().nonnegative(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;

export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "lowercase sha256 hex digest");
export type Sha256 = z.infer<typeof Sha256>;

/**
 * Where a claim came from. Every extracted fact must point at one of these,
 * so the specialist can always be shown the original wording.
 */
export const EvidenceLocation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("document"),
    documentId: DocumentId,
    documentVersionId: DocumentVersionId,
    documentName: z.string().min(1),
    /** 1-based page number for paged formats. */
    page: z.number().int().positive().optional(),
    /** Sheet name for spreadsheets. */
    sheet: z.string().optional(),
    /** Cell or range reference for spreadsheets, e.g. `B12`. */
    cell: z.string().optional(),
  }),
  z.object({
    kind: z.literal("procurement_card"),
    procurementId: ProcurementId,
    /** Field on the platform card the value was read from. */
    field: z.string().min(1),
    url: z.string().url(),
  }),
]);
export type EvidenceLocation = z.infer<typeof EvidenceLocation>;

export const Evidence = z.object({
  id: EvidenceId,
  location: EvidenceLocation,
  /** Verbatim source text. Must not be paraphrased by the model. */
  quote: z.string().min(1),
  capturedAt: IsoDateTime,
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * A single extracted claim. `evidenceIds` is non-empty by contract: a fact
 * without provenance is rejected rather than stored.
 */
export const Fact = z.object({
  id: FactId,
  procurementId: ProcurementId,
  /** Stable machine key, e.g. `commercial.advance_percent`. */
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().optional(),
  evidenceIds: z.array(EvidenceId).min(1, "a fact must cite at least one evidence"),
  confidence: Confidence,
  extractedBy: z.string().min(1),
  extractedAt: IsoDateTime,
});
export type Fact = z.infer<typeof Fact>;

/** Ordering of authority used when instructions contradict each other. */
export const PolicyScope = z.enum([
  "system",
  "company",
  "permanent_intent",
  "domain",
  "procurement",
  "task",
]);
export type PolicyScope = z.infer<typeof PolicyScope>;

export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
