import { z } from "zod";
import { CapabilityId, McpToolName } from "./capability.js";
import { Confidence, Evidence, Fact, IsoDateTime } from "./common.js";
import { CompiledDocumentRef } from "./documents.js";
import { DomainProfile } from "./domain-profile.js";
import {
  AgentRunId,
  DomainProfileId,
  ProcurementId,
  RequestId,
  TaskId,
  ToolCallId,
} from "./ids.js";
import { Intent, ScopedRule } from "./intent.js";
import { ProcurementCaseHeader } from "./procurement.js";

/**
 * The compiled context is the only thing an agent sees. It is assembled by
 * deterministic selection, not by handing the model everything and hoping it
 * picks well.
 */
export const MinimalAgentContext = z.object({
  /** What just happened and why this agent was invoked. */
  event: z.object({
    kind: z.string().min(1),
    description: z.string().min(1),
    occurredAt: IsoDateTime,
  }),
  intent: Intent.pick({ type: true, scope: true, statement: true }).optional(),
  domainProfile: DomainProfile.pick({
    slug: true,
    name: true,
    purpose: true,
    instructions: true,
    keywords: true,
    excludeKeywords: true,
    semanticConcepts: true,
    positiveCriteria: true,
    negativeCriteria: true,
    constraints: true,
  }).optional(),
  /** Already merged through the policy hierarchy. */
  constraints: z.array(z.object({ scope: z.string(), statement: z.string() })).default([]),
  procurement: ProcurementCaseHeader.optional(),
  /** Already ingested blobs this capability is allowed to read. */
  documents: z.array(CompiledDocumentRef).optional(),
  /** Recent decisions and facts scoped to this case or domain only. */
  relevantHistory: z
    .array(z.object({ at: IsoDateTime, summary: z.string().min(1) }))
    .default([]),
  /** Restated for the model, but enforced independently by the policy gate. */
  allowedTools: z.array(McpToolName),
  /** Rough size guard, filled by the compiler. */
  estimatedTokens: z.number().int().nonnegative(),
});
export type MinimalAgentContext = z.infer<typeof MinimalAgentContext>;

/**
 * History rows supplied to the compiler. Only items matching the current
 * procurement or profile are copied into MinimalAgentContext.
 */
export const ContextHistoryItem = z.object({
  at: IsoDateTime,
  summary: z.string().min(1),
  procurementId: ProcurementId.optional(),
  domainProfileId: DomainProfileId.optional(),
});
export type ContextHistoryItem = z.infer<typeof ContextHistoryItem>;

/**
 * Deterministic input to the Context Compiler. The caller already selected
 * the plan step; the compiler never asks a model what to include.
 */
export const ContextCompileRequest = z.object({
  requestId: RequestId,
  event: MinimalAgentContext.shape.event,
  capability: CapabilityId,
  domainProfileId: DomainProfileId.optional(),
  procurementId: ProcurementId.optional(),
  intents: z.array(Intent).default([]),
  domainProfiles: z.array(DomainProfile).default([]),
  scopedRules: z.array(ScopedRule).default([]),
  procurement: ProcurementCaseHeader.optional(),
  documents: z.array(CompiledDocumentRef).default([]),
  relevantHistory: z.array(ContextHistoryItem).default([]),
  systemForbiddenTools: z.array(McpToolName).default([]),
});
export type ContextCompileRequest = z.infer<typeof ContextCompileRequest>;

export const ContextCompilation = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("compiled"),
    context: MinimalAgentContext,
  }),
  z.object({
    status: z.literal("needs_human"),
    humanQuestion: z.string().min(1),
  }),
]);
export type ContextCompilation = z.infer<typeof ContextCompilation>;

export const AgentRunInput = z.object({
  runId: AgentRunId,
  requestId: RequestId,
  taskId: TaskId.optional(),
  procurementId: ProcurementId.optional(),
  domainProfileId: DomainProfileId.optional(),
  capability: CapabilityId,
  context: MinimalAgentContext,
  /** Capability-specific payload, validated by each agent's own schema. */
  input: z.unknown(),
});
export type AgentRunInput = z.infer<typeof AgentRunInput>;

export const AgentRunStatus = z.enum(["success", "failed", "needs_human", "skipped"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

export const AgentError = z.object({
  kind: z.enum(["retryable", "terminal", "permission_denied", "timeout", "invalid_output"]),
  message: z.string().min(1),
  toolName: McpToolName.optional(),
});
export type AgentError = z.infer<typeof AgentError>;

export const AgentRunOutput = z.object({
  runId: AgentRunId,
  status: AgentRunStatus,
  confidence: Confidence,
  /** Capability-specific result. */
  payload: z.unknown(),
  facts: z.array(Fact).default([]),
  evidence: z.array(Evidence).default([]),
  /** Suggestion only - the supervisor decides what actually runs next. */
  nextRecommendedCapability: CapabilityId.optional(),
  humanQuestion: z.string().optional(),
  error: AgentError.optional(),
});
export type AgentRunOutput = z.infer<typeof AgentRunOutput>;

/** One MCP invocation, recorded for the Agent Activity view. */
export const ToolCallRecord = z.object({
  id: ToolCallId,
  runId: AgentRunId,
  toolName: McpToolName,
  arguments: z.unknown(),
  result: z.unknown().optional(),
  ok: z.boolean(),
  errorMessage: z.string().optional(),
  startedAt: IsoDateTime,
  durationMs: z.number().int().nonnegative(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

export const AgentRunRecord = z.object({
  id: AgentRunId,
  requestId: RequestId,
  taskId: TaskId.optional(),
  procurementId: ProcurementId.optional(),
  capability: CapabilityId,
  status: AgentRunStatus,
  model: z.string().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecord>;

/**
 * Structured input to the Supervisor. Raw ingress compilation and context
 * compilation are separate stages; the planner receives only validated state.
 */
export const SupervisorRequest = z.object({
  requestId: RequestId,
  intents: z.array(Intent).min(1),
  domainProfiles: z.array(DomainProfile).default([]),
  scopedRules: z.array(ScopedRule).default([]),
  procurement: ProcurementCaseHeader.optional(),
});
export type SupervisorRequest = z.infer<typeof SupervisorRequest>;

/**
 * What the supervisor is allowed to produce. It plans and delegates; it never
 * returns scraped data or documents of its own.
 */
export const SupervisorPlan = z
  .object({
    intentSummary: z.string().min(1),
    selectedDomainProfileIds: z.array(DomainProfileId).default([]),
    steps: z
      .array(
        z.object({
          capability: CapabilityId,
          reason: z.string().min(1),
          domainProfileId: DomainProfileId.optional(),
          procurementId: ProcurementId.optional(),
        }),
      )
      .default([]),
    needsHuman: z.boolean().default(false),
    humanQuestion: z.string().min(1).optional(),
    confidence: Confidence,
  })
  .superRefine((plan, context) => {
    if (plan.needsHuman && plan.humanQuestion === undefined) {
      context.addIssue({
        code: "custom",
        path: ["humanQuestion"],
        message: "humanQuestion is required when needsHuman is true",
      });
    }
  });
export type SupervisorPlan = z.infer<typeof SupervisorPlan>;
