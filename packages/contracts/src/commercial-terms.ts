import { z } from "zod";
import { CommercialTerms } from "./analysis.js";
import { Confidence, IsoDateTime, Sha256 } from "./common.js";
import { CompiledDocumentRef } from "./documents.js";

/**
 * Stable keys written onto Fact.key. Scoring reads these; the model must not
 * invent a 0..100 verdict under any of them.
 */
export const CommercialFactKey = z.enum([
  "commercial.advance_percent",
  "commercial.payment_kind",
  "commercial.final_payment_percent",
  "commercial.payment_deadline_days",
  "commercial.delivery_period_days",
  "commercial.warranty_months",
  "commercial.price",
  "commercial.bid_security",
  "commercial.contract_security",
  "commercial.penalties",
]);
export type CommercialFactKey = z.infer<typeof CommercialFactKey>;

/** One proposed commercial claim. Rejected unless `quote` appears on `page`. */
export const CommercialClaim = z.object({
  key: CommercialFactKey,
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  confidence: Confidence,
  hash: Sha256,
  page: z.number().int().positive(),
  quote: z.string().min(1),
});
export type CommercialClaim = z.infer<typeof CommercialClaim>;

export const CommercialExtractorPage = z.object({
  hash: Sha256,
  name: z.string().min(1),
  page: z.number().int().positive(),
  text: z.string(),
});
export type CommercialExtractorPage = z.infer<typeof CommercialExtractorPage>;

export const CommercialExtractorInput = z.object({
  pages: z.array(CommercialExtractorPage).min(1),
});
export type CommercialExtractorInput = z.infer<typeof CommercialExtractorInput>;

export const CommercialExtractorOutput = z.object({
  claims: z.array(CommercialClaim).default([]),
});
export type CommercialExtractorOutput = z.infer<typeof CommercialExtractorOutput>;

export const CommercialExtractionInput = z.object({
  documents: z.array(CompiledDocumentRef).default([]),
});
export type CommercialExtractionInput = z.infer<typeof CommercialExtractionInput>;

export const CommercialExtractionOutput = z.object({
  terms: CommercialTerms,
  skippedDocumentCount: z.number().int().nonnegative(),
  extractedAt: IsoDateTime,
});
export type CommercialExtractionOutput = z.infer<typeof CommercialExtractionOutput>;
