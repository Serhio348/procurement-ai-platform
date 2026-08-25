import { z } from "zod";
import { CapabilityId, McpToolName } from "./capability.js";
import { IsoDateTime } from "./common.js";
import { CompanyId, DomainProfileId, UserId } from "./ids.js";

/**
 * A domain profile is data, not code. Water treatment, pumps and dosing are
 * rows in this shape - never separate agent classes. The specialist owns this
 * object end to end through the web UI.
 */

export const DomainConstraint = z.object({
  key: z.string().min(1),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in", "contains"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]),
  /** Hard constraints disqualify a procurement outright. */
  hard: z.boolean().default(true),
  rationale: z.string().optional(),
});
export type DomainConstraint = z.infer<typeof DomainConstraint>;

export const DomainCriterion = z.object({
  text: z.string().min(1),
  /** Relative pull of this criterion inside its group. */
  weight: z.number().min(0).max(1).default(0.5),
});
export type DomainCriterion = z.infer<typeof DomainCriterion>;

export const DomainScoringRules = z.object({
  /** Which formula version computes the final score for this domain. */
  formulaId: z.string().min(1),
  weights: z.object({
    technical: z.number().min(0),
    commercial: z.number().min(0),
    deadline: z.number().min(0),
    risk: z.number().min(0),
    companyMatch: z.number().min(0),
  }),
  /** Below this the case is discarded without deep investigation. */
  minRelevanceToInvestigate: z.number().min(0).max(1),
  /** Below this a human is asked instead of the system deciding. */
  minConfidenceToDecide: z.number().min(0).max(1),
});
export type DomainScoringRules = z.infer<typeof DomainScoringRules>;

export const DomainMonitoringRule = z.object({
  watch: z.enum([
    "status",
    "price",
    "deadlines",
    "documents",
    "technical_specification",
    "contract",
    "auction_info",
  ]),
  /** How often the monitor re-checks, in minutes. */
  intervalMinutes: z.number().int().positive(),
  notifyOnChange: z.boolean().default(true),
  urgent: z.boolean().default(false),
});
export type DomainMonitoringRule = z.infer<typeof DomainMonitoringRule>;

export const DomainProfile = z.object({
  id: DomainProfileId,
  companyId: CompanyId,
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "slug must be a lowercase identifier")
    .max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(""),
  purpose: z.string().max(4000).default(""),
  /** Free-form guidance handed to the agent after context compilation. */
  instructions: z.string().max(8000).default(""),

  keywords: z.array(z.string().min(1)).default([]),
  semanticConcepts: z.array(z.string().min(1)).default([]),
  positiveCriteria: z.array(DomainCriterion).default([]),
  negativeCriteria: z.array(DomainCriterion).default([]),
  constraints: z.array(DomainConstraint).default([]),
  scoringRules: DomainScoringRules,
  monitoringRules: z.array(DomainMonitoringRule).default([]),

  /** Capabilities this profile is allowed to invoke. */
  associatedCapabilities: z.array(CapabilityId).default([]),
  /** Narrows agent permissions further; never widens them. */
  associatedMcpTools: z.array(McpToolName).default([]),

  enabled: z.boolean().default(true),
  archived: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).default(50),

  createdBy: UserId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DomainProfile = z.infer<typeof DomainProfile>;

/** Payload accepted from the UI when creating a profile. */
export const DomainProfileDraft = DomainProfile.omit({
  id: true,
  companyId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
});
export type DomainProfileDraft = z.infer<typeof DomainProfileDraft>;

/**
 * What the LLM returns when a specialist describes a new direction in prose.
 * It is a proposal only: nothing is persisted until the specialist confirms.
 */
export const DomainProfileProposal = z.object({
  draft: DomainProfileDraft,
  /** Plain-language read-back shown as "I understood the task as...". */
  interpretation: z.string().min(1),
  /** Anything the model had to guess, surfaced for review. */
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type DomainProfileProposal = z.infer<typeof DomainProfileProposal>;
