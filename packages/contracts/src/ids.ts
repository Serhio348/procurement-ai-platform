import { z } from "zod";

/**
 * Branded identifiers. Branding is deliberate: a ProcurementId must never be
 * accepted where a DocumentId is expected, even though both are strings at
 * runtime.
 */

export const CompanyId = z.string().uuid().brand<"CompanyId">();
export type CompanyId = z.infer<typeof CompanyId>;

export const UserId = z.string().uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;

export const WorkspaceId = z.string().uuid().brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const WorkspaceProcurementId = z.string().uuid().brand<"WorkspaceProcurementId">();
export type WorkspaceProcurementId = z.infer<typeof WorkspaceProcurementId>;

export const DomainProfileId = z.string().uuid().brand<"DomainProfileId">();
export type DomainProfileId = z.infer<typeof DomainProfileId>;

export const IntentId = z.string().uuid().brand<"IntentId">();
export type IntentId = z.infer<typeof IntentId>;

export const TaskId = z.string().uuid().brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;

export const ProcurementId = z.string().uuid().brand<"ProcurementId">();
export type ProcurementId = z.infer<typeof ProcurementId>;

export const LotId = z.string().uuid().brand<"LotId">();
export type LotId = z.infer<typeof LotId>;

export const PositionId = z.string().uuid().brand<"PositionId">();
export type PositionId = z.infer<typeof PositionId>;

export const PartyId = z.string().uuid().brand<"PartyId">();
export type PartyId = z.infer<typeof PartyId>;

export const ContactId = z.string().uuid().brand<"ContactId">();
export type ContactId = z.infer<typeof ContactId>;

export const RawArtifactId = z.string().uuid().brand<"RawArtifactId">();
export type RawArtifactId = z.infer<typeof RawArtifactId>;

export const ClarificationId = z.string().uuid().brand<"ClarificationId">();
export type ClarificationId = z.infer<typeof ClarificationId>;

export const JobRunId = z.string().uuid().brand<"JobRunId">();
export type JobRunId = z.infer<typeof JobRunId>;

export const RelevanceAssessmentId = z.string().uuid().brand<"RelevanceAssessmentId">();
export type RelevanceAssessmentId = z.infer<typeof RelevanceAssessmentId>;

export const ActivityAssessmentId = z.string().uuid().brand<"ActivityAssessmentId">();
export type ActivityAssessmentId = z.infer<typeof ActivityAssessmentId>;

export const SeedRunId = z.string().min(1).brand<"SeedRunId">();
export type SeedRunId = z.infer<typeof SeedRunId>;

export const DocumentId = z.string().uuid().brand<"DocumentId">();
export type DocumentId = z.infer<typeof DocumentId>;

export const DocumentVersionId = z.string().uuid().brand<"DocumentVersionId">();
export type DocumentVersionId = z.infer<typeof DocumentVersionId>;

export const FactId = z.string().uuid().brand<"FactId">();
export type FactId = z.infer<typeof FactId>;

export const EvidenceId = z.string().uuid().brand<"EvidenceId">();
export type EvidenceId = z.infer<typeof EvidenceId>;

export const RiskId = z.string().uuid().brand<"RiskId">();
export type RiskId = z.infer<typeof RiskId>;

export const ScoreSnapshotId = z.string().uuid().brand<"ScoreSnapshotId">();
export type ScoreSnapshotId = z.infer<typeof ScoreSnapshotId>;

export const MonitoringRuleId = z.string().uuid().brand<"MonitoringRuleId">();
export type MonitoringRuleId = z.infer<typeof MonitoringRuleId>;

export const ChangeEventId = z.string().uuid().brand<"ChangeEventId">();
export type ChangeEventId = z.infer<typeof ChangeEventId>;

export const DecisionId = z.string().uuid().brand<"DecisionId">();
export type DecisionId = z.infer<typeof DecisionId>;

export const NotificationId = z.string().uuid().brand<"NotificationId">();
export type NotificationId = z.infer<typeof NotificationId>;

export const AgentRunId = z.string().uuid().brand<"AgentRunId">();
export type AgentRunId = z.infer<typeof AgentRunId>;

export const ToolCallId = z.string().uuid().brand<"ToolCallId">();
export type ToolCallId = z.infer<typeof ToolCallId>;

export const RequestId = z.string().min(1).brand<"RequestId">();
export type RequestId = z.infer<typeof RequestId>;

/**
 * Identifier of a procurement platform adapter, e.g. `goszakupki_by`.
 * Not a UUID: it is a stable slug referenced from configuration.
 */
export const SourceId = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "source id must be a lowercase slug")
  .brand<"SourceId">();
export type SourceId = z.infer<typeof SourceId>;

/**
 * Procedure number as published by the external platform, e.g. `3545578`.
 * Opaque on purpose: every platform numbers procedures differently.
 */
export const SourceProcurementId = z.string().min(1).brand<"SourceProcurementId">();
export type SourceProcurementId = z.infer<typeof SourceProcurementId>;
