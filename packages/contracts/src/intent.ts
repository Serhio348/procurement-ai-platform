import { z } from "zod";
import { IsoDateTime, PolicyScope } from "./common.js";
import { CompanyId, DomainProfileId, IntentId, ProcurementId, UserId } from "./ids.js";

/**
 * A message from the specialist is compiled into one of these. Chat history is
 * not the system of record - these rows are.
 */
export const IntentType = z.enum([
  "permanent_intent",
  "one_time_task",
  "monitoring_request",
  "constraint",
  "preference",
  "rule",
  "exception",
  "instruction",
  "question",
]);
export type IntentType = z.infer<typeof IntentType>;

export const Intent = z.object({
  id: IntentId,
  companyId: CompanyId,
  createdBy: UserId,
  type: IntentType,
  scope: PolicyScope,

  /** Exactly what the specialist wrote, kept for audit and re-interpretation. */
  rawMessage: z.string().min(1),
  /** Normalised single-sentence statement of the intent. */
  statement: z.string().min(1),

  domainProfileIds: z.array(DomainProfileId).default([]),
  procurementId: ProcurementId.optional(),

  active: z.boolean().default(true),
  /**
   * Set only when the specialist explicitly confirmed a replacement. A new
   * intent never deactivates an older one on its own.
   */
  supersedesIntentId: IntentId.optional(),

  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Intent = z.infer<typeof Intent>;

/**
 * Output of the intent compiler. Several intents may come from one message
 * ("search water treatment, but skip household systems" is two).
 */
export const IntentCompilation = z.object({
  intents: z.array(
    Intent.omit({
      id: true,
      companyId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    }),
  ),
  interpretation: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** True when the message is ambiguous enough to require a clarification. */
  needsHuman: z.boolean().default(false),
  humanQuestion: z.string().optional(),
});
export type IntentCompilation = z.infer<typeof IntentCompilation>;

/**
 * A rule as seen by the conflict resolver: a statement plus the authority it
 * carries. Two contradicting rules at the same scope are never resolved
 * silently.
 */
export const ScopedRule = z.object({
  id: z.string().min(1),
  scope: PolicyScope,
  /** Machine key the rule constrains, e.g. `search.include_household`. */
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  statement: z.string().min(1),
  sourceIntentId: IntentId.optional(),
  domainProfileId: DomainProfileId.optional(),
  procurementId: ProcurementId.optional(),
  createdAt: IsoDateTime,
});
export type ScopedRule = z.infer<typeof ScopedRule>;
