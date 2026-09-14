import { z } from "zod";
import { Confidence, IsoDateTime } from "./common.js";
import { SourceId, SourceProcurementId } from "./ids.js";
import { ProcedureKind, SearchHit } from "./procurement.js";

/**
 * Capability-specific input for DomainSearchAgent. Keywords come from the
 * compiled Domain Profile, not from this payload, so a specialist cannot
 * silently switch the search topic for one run.
 */
export const DomainSearchInput = z.object({
  sourceId: SourceId,
  publishedFrom: IsoDateTime.optional(),
  publishedTo: IsoDateTime.optional(),
  kinds: z.array(ProcedureKind).default([]),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type DomainSearchInput = z.infer<typeof DomainSearchInput>;

export const DomainSearchCandidate = z.object({
  sourceId: SourceId,
  sourceProcurementId: SourceProcurementId,
  url: z.string().url(),
  title: z.string().min(1),
  verdict: z.enum(["relevant", "irrelevant", "needs_human"]),
  confidence: Confidence,
  reason: z.string().min(1),
  /** True when only the listing was seen and documents were not fetched. */
  needDeeper: z.boolean(),
  matchedTerms: z.array(z.string()).default([]),
  excludedBy: z.array(z.string()).default([]),
  classifiedBy: z.enum(["keywords", "exclude", "model", "quota"]),
});
export type DomainSearchCandidate = z.infer<typeof DomainSearchCandidate>;

export const DomainSearchOutput = z.object({
  query: z.object({
    sourceId: SourceId,
    keywords: z.array(z.string()),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  }),
  candidates: z.array(DomainSearchCandidate),
  relevantCount: z.number().int().nonnegative(),
  discardedCount: z.number().int().nonnegative(),
  modelClassifiedCount: z.number().int().nonnegative(),
});
export type DomainSearchOutput = z.infer<typeof DomainSearchOutput>;

/** Listing row plus optional card fields the classifier is allowed to see. */
export const SearchClassifierInput = z.object({
  profile: z.object({
    name: z.string(),
    purpose: z.string(),
    instructions: z.string(),
    keywords: z.array(z.string()),
    excludeKeywords: z.array(z.string()),
    semanticConcepts: z.array(z.string()),
    positiveCriteria: z.array(z.string()),
    negativeCriteria: z.array(z.string()),
  }),
  hit: SearchHit,
  card: z
    .object({
      title: z.string(),
      lotTitles: z.array(z.string()).default([]),
      rawFields: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
});
export type SearchClassifierInput = z.infer<typeof SearchClassifierInput>;

/**
 * How a specialist phrase breaks into search axes. Produced by a model or a
 * cheap parser; the 0–100 score is never in this object and is never set by
 * a model.
 */
export const SearchIntentPlan = z.object({
  /** Equipment / goods the specialist wants, not the type of work. */
  objects: z.array(z.string().min(1).max(120)).max(20).default([]),
  /**
   * Required purpose of that equipment. Empty means the profile did not
   * name a purpose.
   */
  required_context: z.array(z.string().min(1).max(120)).max(20).default([]),
  /**
   * Purposes the profile explicitly does not want. Empty means none were
   * stated. Scoring must not invent a domain list here.
   */
  excluded_context: z.array(z.string().min(1).max(120)).max(20).default([]),
  /** Supply-side verbs: поставка, изготовление. */
  desired_actions: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** Work verbs that should not win on their own: монтаж, ремонт, … */
  excluded_actions: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** Free label for logs; scoring keys off the arrays, not this string. */
  intent: z.string().min(1).max(64).default("equipment_purchase"),
});
export type SearchIntentPlan = z.infer<typeof SearchIntentPlan>;

/** Profile slice the intent parser may see. No scores. */
export const SearchIntentParserInput = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  excludeKeywords: z.array(z.string()),
});
export type SearchIntentParserInput = z.infer<typeof SearchIntentParserInput>;
