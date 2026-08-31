import { z } from "zod";
import { CapabilityId } from "./capability.js";
import { IsoDateTime, PolicyScope } from "./common.js";
import {
  CompanyId,
  DomainProfileId,
  IntentId,
  MonitoringRuleId,
  ProcurementId,
  TaskId,
  UserId,
} from "./ids.js";

export const TaskType = z.enum(["permanent", "one_time", "monitoring", "human_review"]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskStatus = z.enum([
  "active",
  "paused",
  "waiting_human",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskSchedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), runAt: IsoDateTime }),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().positive() }),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1), timezone: z.string().min(1) }),
]);
export type TaskSchedule = z.infer<typeof TaskSchedule>;

export const Task = z.object({
  id: TaskId,
  companyId: CompanyId,
  type: TaskType,
  status: TaskStatus,
  scope: PolicyScope,

  intentId: IntentId,
  domainProfileId: DomainProfileId.optional(),
  procurementId: ProcurementId.optional(),
  monitoringRuleId: MonitoringRuleId.optional(),

  /** Capabilities the planner expects this task to need. */
  capabilities: z.array(CapabilityId).default([]),

  priority: z.number().int().min(0).max(100).default(50),
  schedule: TaskSchedule.optional(),

  title: z.string().min(1).max(300),
  createdBy: UserId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastRunAt: IsoDateTime.optional(),
  nextRunAt: IsoDateTime.optional(),
});
export type Task = z.infer<typeof Task>;

/** Options offered to the specialist when a case is escalated. */
export const HumanDecisionKind = z.enum([
  "approve",
  "reject",
  "investigate",
  "monitor",
  "ignore",
  "treat_as_active",
  "skip",
  "review_later",
]);
export type HumanDecisionKind = z.infer<typeof HumanDecisionKind>;

export const HumanReviewRequest = z.object({
  taskId: TaskId,
  procurementId: ProcurementId.optional(),
  /** Why the system refused to decide on its own. */
  reason: z.string().min(1),
  question: z.string().min(1),
  options: z.array(HumanDecisionKind).min(1),
  /** Conflicting statements shown side by side, when applicable. */
  conflicting: z
    .array(z.object({ scope: PolicyScope, statement: z.string().min(1) }))
    .default([]),
  createdAt: IsoDateTime,
});
export type HumanReviewRequest = z.infer<typeof HumanReviewRequest>;
