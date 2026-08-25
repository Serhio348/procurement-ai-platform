import { z } from "zod";
import { Confidence, Money } from "./common.js";
import { FactId } from "./ids.js";

/**
 * Extraction results. Each field carries the facts it was derived from, so the
 * UI can always answer "where did this number come from".
 */

const Sourced = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    factIds: z.array(FactId).min(1),
    confidence: Confidence,
  });

export const PaymentKind = z.enum([
  "advance",
  "on_delivery",
  "deferred",
  "staged",
  "letter_of_credit",
  "unknown",
]);
export type PaymentKind = z.infer<typeof PaymentKind>;

export const CommercialTerms = z.object({
  price: Sourced(Money).optional(),
  paymentKind: Sourced(PaymentKind).optional(),
  /** Share of the contract paid up front, 0..100. */
  advancePercent: Sourced(z.number().min(0).max(100)).optional(),
  finalPaymentPercent: Sourced(z.number().min(0).max(100)).optional(),
  /** Calendar days from delivery/acceptance to payment. */
  paymentDeadlineDays: Sourced(z.number().int().nonnegative()).optional(),
  deliveryPeriodDays: Sourced(z.number().int().nonnegative()).optional(),
  warrantyMonths: Sourced(z.number().int().nonnegative()).optional(),
  bidSecurity: Sourced(Money).optional(),
  contractSecurity: Sourced(Money).optional(),
  penalties: Sourced(z.string()).optional(),
  notes: z.array(z.string()).default([]),
});
export type CommercialTerms = z.infer<typeof CommercialTerms>;

export const AuctionInfo = z.object({
  isAuction: Sourced(z.boolean()),
  priceReductionAllowed: Sourced(z.boolean()).optional(),
  auctionStepPercent: Sourced(z.number().min(0).max(100)).optional(),
  initialPrice: Sourced(Money).optional(),
  finalPrice: Sourced(Money).optional(),
  reductionPercent: Sourced(z.number().min(0).max(100)).optional(),
  rules: z.array(z.string()).default([]),
});
export type AuctionInfo = z.infer<typeof AuctionInfo>;

export const TechnicalAnalysis = z.object({
  equipment: z.array(z.string()).default([]),
  capacity: Sourced(z.string()).optional(),
  specifications: z.array(z.string()).default([]),
  scopeOfSupply: z.array(z.string()).default([]),
  installationRequired: Sourced(z.boolean()).optional(),
  commissioningRequired: Sourced(z.boolean()).optional(),
  serviceRequired: Sourced(z.boolean()).optional(),
  qualificationRequirements: z.array(z.string()).default([]),
});
export type TechnicalAnalysis = z.infer<typeof TechnicalAnalysis>;
