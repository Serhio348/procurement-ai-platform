import type {
  ActivityAssessment,
  DomainConstraint,
  DomainCriterion,
  DomainMonitoringRule,
  EvidenceLocation,
  HumanDecisionKind,
  McpToolName,
  PlatformAmount,
  PlatformInstant,
  RelevanceAssessment,
  ScoreComponents,
  ScoringFormula,
} from "@procurement/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const procedureStatus = pgEnum("procedure_status", [
  "announced",
  "accepting_bids",
  "bidding_closed",
  "auction_in_progress",
  "under_review",
  "completed",
  "cancelled",
  "failed",
  "unknown",
]);

export const investigationStage = pgEnum("investigation_stage", [
  "discovered",
  "classified",
  "card_fetched",
  "waiting_human",
  "inactive",
  "documents_downloaded",
  "documents_extracted",
  "commercial_analysed",
  "scored",
  "reported",
  "monitoring",
  "discarded",
]);

export const documentLifecycle = pgEnum("document_lifecycle", ["active", "deleted"]);
export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "waiting_human",
]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "sending", "sent", "failed"]);

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const seedRuns = pgTable("seed_runs", {
  seedId: varchar("seed_id", { length: 128 }).primaryKey(),
  appliedAt: timestamptz("applied_at").notNull().defaultNow(),
});

export const scoringFormulas = pgTable(
  "scoring_formulas",
  {
    id: varchar("id", { length: 128 }).notNull(),
    version: integer("version").notNull(),
    config: jsonb("config").$type<ScoringFormula>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    check("scoring_formula_version_positive", sql`${table.version} > 0`),
  ],
);

export const domainProfiles = pgTable(
  "domain_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description").notNull().default(""),
    purpose: text("purpose").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    excludeKeywords: jsonb("exclude_keywords").$type<string[]>().notNull().default([]),
    semanticConcepts: jsonb("semantic_concepts").$type<string[]>().notNull().default([]),
    positiveCriteria: jsonb("positive_criteria").$type<DomainCriterion[]>().notNull().default([]),
    negativeCriteria: jsonb("negative_criteria").$type<DomainCriterion[]>().notNull().default([]),
    constraints: jsonb("constraints").$type<DomainConstraint[]>().notNull().default([]),
    formulaId: varchar("formula_id", { length: 128 }).notNull(),
    formulaVersion: integer("formula_version").notNull().default(1),
    minRelevance: numeric("min_relevance", { precision: 4, scale: 3 }).notNull(),
    minConfidence: numeric("min_confidence", { precision: 4, scale: 3 }).notNull(),
    monitoringRules: jsonb("monitoring_rules").$type<DomainMonitoringRule[]>().notNull().default([]),
    associatedCapabilities: jsonb("associated_capabilities").$type<string[]>().notNull().default([]),
    associatedMcpTools: jsonb("associated_mcp_tools").$type<McpToolName[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    priority: integer("priority").notNull().default(50),
    createdBy: uuid("created_by"),
    workspaceId: uuid("workspace_id"),
    searchConfig: jsonb("search_config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("domain_profiles_company_slug_uq").on(table.companyId, table.slug),
    index("domain_profiles_workspace_idx").on(table.workspaceId),
    uniqueIndex("domain_profiles_workspace_slug_uq").on(table.workspaceId, table.slug),
    index("domain_profiles_active_idx").on(table.companyId, table.enabled, table.archived),
    check("domain_profiles_priority_range", sql`${table.priority} between 0 and 100`),
    check("domain_profiles_min_relevance_range", sql`${table.minRelevance} between 0 and 1`),
    check("domain_profiles_min_confidence_range", sql`${table.minConfidence} between 0 and 1`),
  ],
);

export const intents = pgTable(
  "intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    rawMessage: text("raw_message").notNull(),
    statement: text("statement").notNull(),
    procurementId: uuid("procurement_id"),
    active: boolean("active").notNull().default(true),
    supersedesIntentId: uuid("supersedes_intent_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("intents_company_active_idx").on(table.companyId, table.active)],
);

export const intentDomainProfiles = pgTable(
  "intent_domain_profiles",
  {
    intentId: uuid("intent_id")
      .notNull()
      .references(() => intents.id, { onDelete: "cascade" }),
    domainProfileId: uuid("domain_profile_id")
      .notNull()
      .references(() => domainProfiles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.intentId, table.domainProfileId] })],
);

export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 32 }).notNull(),
    key: varchar("key", { length: 200 }).notNull(),
    value: jsonb("value").notNull(),
    statement: text("statement").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("policies_scope_key_idx").on(table.scope, table.key, table.active)],
);

export const procurements = pgTable(
  "procurements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    sourceRecordId: varchar("source_record_id", { length: 256 }).notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    pageFamily: varchar("page_family", { length: 32 }),
    title: text("title").notNull(),
    kind: varchar("kind", { length: 64 }).notNull().default("other"),
    status: procedureStatus("status").notNull().default("unknown"),
    sourceStatus: text("source_status"),
    stage: investigationStage("stage").notNull().default("discovered"),
    amount: jsonb("amount").$type<PlatformAmount>(),
    publishedAt: jsonb("published_at").$type<PlatformInstant>(),
    bidsDeadline: jsonb("bids_deadline").$type<PlatformInstant>(),
    rawFields: jsonb("raw_fields").$type<Record<string, string>>().notNull().default({}),
    relevance: numeric("relevance", { precision: 4, scale: 3 }),
    relevanceReason: text("relevance_reason"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("procurements_source_record_uq").on(table.sourceId, table.sourceRecordId),
    index("procurements_status_stage_idx").on(table.status, table.stage),
  ],
);

export const externalIds = pgTable(
  "procurement_external_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [uniqueIndex("procurement_external_ids_uq").on(table.procurementId, table.kind, table.value)],
);

export const parties = pgTable(
  "procurement_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 64 }).notNull(),
    name: text("name").notNull(),
    registrationNumber: varchar("registration_number", { length: 64 }),
    address: text("address"),
  },
  (table) => [index("procurement_parties_procurement_idx").on(table.procurementId)],
);

export const contacts = pgTable("party_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id")
    .notNull()
    .references(() => parties.id, { onDelete: "cascade" }),
  name: text("name"),
  role: text("role"),
  phone: text("phone"),
  email: text("email"),
  raw: text("raw").notNull(),
});

export const lots = pgTable(
  "procurement_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    number: varchar("number", { length: 64 }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status"),
    amount: jsonb("amount").$type<PlatformAmount>(),
    quantity: numeric("quantity"),
    unit: varchar("unit", { length: 64 }),
    deliveryPlace: text("delivery_place"),
    deliveryTerm: text("delivery_term"),
    funding: text("funding"),
    paymentTermsRaw: text("payment_terms_raw"),
    bidSecurity: text("bid_security"),
    contractSecurity: text("contract_security"),
    okrbCode: varchar("okrb_code", { length: 64 }),
  },
  (table) => [uniqueIndex("procurement_lots_number_uq").on(table.procurementId, table.number)],
);

export const positions = pgTable(
  "lot_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => lots.id, { onDelete: "cascade" }),
    externalNumber: varchar("external_number", { length: 64 }),
    title: text("title").notNull(),
    quantity: numeric("quantity"),
    unit: varchar("unit", { length: 64 }),
  },
  (table) => [index("lot_positions_lot_idx").on(table.lotId)],
);

export const rawArtifacts = pgTable(
  "raw_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: varchar("content_type", { length: 255 }).notNull(),
    pageFamily: varchar("page_family", { length: 32 }),
    capturedAt: timestamptz("captured_at").notNull(),
  },
  (table) => [
    uniqueIndex("raw_artifacts_procurement_hash_uq").on(table.procurementId, table.hash),
    index("raw_artifacts_hash_idx").on(table.hash),
  ],
);

export const documents = pgTable(
  "procurement_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sourceUrl: text("source_url").notNull(),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    sourceFileKey: varchar("source_file_key", { length: 128 }),
    metadataUrl: text("metadata_url"),
    downloadUrl: text("download_url"),
    sizeBytes: integer("size_bytes"),
    currentVersionId: uuid("current_version_id"),
    status: varchar("status", { length: 32 }).notNull().default("discovered"),
    lifecycle: documentLifecycle("lifecycle").notNull().default("active"),
    discoveredAt: timestamptz("discovered_at").notNull(),
  },
  (table) => [
    index("procurement_documents_procurement_idx").on(table.procurementId),
    check("procurement_documents_size_nonnegative", sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    downloadedAt: timestamptz("downloaded_at").notNull(),
    storageKey: text("storage_key").notNull(),
    pageCount: integer("page_count"),
    extractedTextLength: integer("extracted_text_length"),
    ocrApplied: boolean("ocr_applied").notNull().default(false),
  },
  (table) => [
    uniqueIndex("document_versions_number_uq").on(table.documentId, table.version),
    uniqueIndex("document_versions_document_hash_uq").on(table.documentId, table.hash),
    index("document_versions_hash_idx").on(table.hash),
    check("document_versions_version_positive", sql`${table.version} > 0`),
    check("document_versions_size_nonnegative", sql`${table.sizeBytes} >= 0`),
  ],
);

export const clarifications = pgTable("procurement_clarifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  procurementId: uuid("procurement_id")
    .notNull()
    .references(() => procurements.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer"),
  askedAt: timestamptz("asked_at"),
  answeredAt: timestamptz("answered_at"),
  sourceUrl: text("source_url"),
});

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    location: jsonb("location").$type<EvidenceLocation>().notNull(),
    quote: text("quote").notNull(),
    capturedAt: timestamptz("captured_at").notNull(),
  },
  (table) => [index("evidence_procurement_idx").on(table.procurementId)],
);

export const facts = pgTable(
  "facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    value: jsonb("value").notNull(),
    unit: varchar("unit", { length: 64 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    extractedBy: varchar("extracted_by", { length: 128 }).notNull(),
    extractedAt: timestamptz("extracted_at").notNull(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    index("facts_procurement_key_idx").on(table.procurementId, table.key),
    index("facts_workspace_idx").on(table.workspaceId),
    check("facts_confidence_range", sql`${table.confidence} between 0 and 1`),
  ],
);

export const factEvidence = pgTable(
  "fact_evidence",
  {
    factId: uuid("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.factId, table.evidenceId] })],
);

export const risks = pgTable(
  "risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 128 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    description: text("description").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    detectedBy: varchar("detected_by", { length: 128 }).notNull(),
    detectedAt: timestamptz("detected_at").notNull(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [index("risks_workspace_idx").on(table.workspaceId)],
);

export const riskFacts = pgTable(
  "risk_facts",
  {
    riskId: uuid("risk_id")
      .notNull()
      .references(() => risks.id, { onDelete: "cascade" }),
    factId: uuid("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "restrict" }),
  },
  (table) => [primaryKey({ columns: [table.riskId, table.factId] })],
);

export const relevanceAssessments = pgTable("relevance_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  procurementId: uuid("procurement_id")
    .notNull()
    .references(() => procurements.id, { onDelete: "cascade" }),
  domainProfileId: uuid("domain_profile_id")
    .notNull()
    .references(() => domainProfiles.id, { onDelete: "restrict" }),
  assessment: jsonb("assessment").$type<RelevanceAssessment>().notNull(),
  assessedAt: timestamptz("assessed_at").notNull(),
});

export const activityAssessments = pgTable("activity_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  procurementId: uuid("procurement_id")
    .notNull()
    .references(() => procurements.id, { onDelete: "cascade" }),
  assessment: jsonb("assessment").$type<ActivityAssessment>().notNull(),
  assessedAt: timestamptz("assessed_at").notNull(),
});

export const scoreSnapshots = pgTable(
  "score_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    formulaId: varchar("formula_id", { length: 128 }).notNull(),
    formulaVersion: integer("formula_version").notNull(),
    components: jsonb("components").$type<ScoreComponents>().notNull(),
    weightedScore: numeric("weighted_score", { precision: 6, scale: 2 }).notNull(),
    riskPenalty: numeric("risk_penalty", { precision: 6, scale: 2 }).notNull(),
    finalScore: numeric("final_score", { precision: 6, scale: 2 }).notNull(),
    verdict: varchar("verdict", { length: 32 }).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    explanation: jsonb("explanation").$type<string[]>().notNull().default([]),
    computedAt: timestamptz("computed_at").notNull(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    index("score_snapshots_procurement_computed_idx").on(table.procurementId, table.computedAt),
    index("score_snapshots_workspace_idx").on(table.workspaceId),
  ],
);

export const monitoringRules = pgTable(
  "monitoring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainProfileId: uuid("domain_profile_id").references(() => domainProfiles.id, {
      onDelete: "cascade",
    }),
    procurementId: uuid("procurement_id").references(() => procurements.id, {
      onDelete: "cascade",
    }),
    watch: varchar("watch", { length: 64 }).notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    notifyOnChange: boolean("notify_on_change").notNull().default(true),
    urgent: boolean("urgent").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    index("monitoring_rules_active_idx").on(table.active),
    index("monitoring_rules_workspace_idx").on(table.workspaceId),
    check(
      "monitoring_rules_owner_present",
      sql`${table.domainProfileId} is not null or ${table.procurementId} is not null`,
    ),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => intents.id, { onDelete: "restrict" }),
    domainProfileId: uuid("domain_profile_id").references(() => domainProfiles.id, {
      onDelete: "set null",
    }),
    procurementId: uuid("procurement_id").references(() => procurements.id, {
      onDelete: "set null",
    }),
    monitoringRuleId: uuid("monitoring_rule_id").references(() => monitoringRules.id, {
      onDelete: "set null",
    }),
    type: varchar("type", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
    priority: integer("priority").notNull().default(50),
    schedule: jsonb("schedule"),
    title: varchar("title", { length: 300 }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    lastRunAt: timestamptz("last_run_at"),
    nextRunAt: timestamptz("next_run_at"),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    index("tasks_status_type_idx").on(table.status, table.type),
    index("tasks_next_run_idx").on(table.nextRunAt),
    index("tasks_workspace_idx").on(table.workspaceId),
    check("tasks_priority_range", sql`${table.priority} between 0 and 100`),
  ],
);

export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 64 }).notNull(),
    field: text("field"),
    previous: text("previous"),
    current: text("current"),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    previousVersionId: uuid("previous_version_id").references(() => documentVersions.id, {
      onDelete: "set null",
    }),
    currentVersionId: uuid("current_version_id").references(() => documentVersions.id, {
      onDelete: "set null",
    }),
    detectedAt: timestamptz("detected_at").notNull(),
    urgent: boolean("urgent").notNull().default(false),
  },
  (table) => [
    uniqueIndex("change_events_procurement_key_uq").on(table.procurementId, table.eventKey),
    index("change_events_detected_idx").on(table.detectedAt),
  ],
);

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  procurementId: uuid("procurement_id").references(() => procurements.id, {
    onDelete: "restrict",
  }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 32 }).$type<HumanDecisionKind>().notNull(),
  madeBy: uuid("made_by"),
  comment: text("comment"),
  scoreSnapshotId: uuid("score_snapshot_id").references(() => scoreSnapshots.id, {
    onDelete: "restrict",
  }),
  madeAt: timestamptz("made_at").notNull(),
});

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 128 }).notNull(),
    status: jobStatus("status").notNull().default("pending"),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    error: jsonb("error"),
    attempt: integer("attempt").notNull().default(0),
    checkpoint: jsonb("checkpoint"),
    requestId: varchar("request_id", { length: 128 }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    intentId: uuid("intent_id").references(() => intents.id, { onDelete: "set null" }),
    domainProfileId: uuid("domain_profile_id").references(() => domainProfiles.id, {
      onDelete: "set null",
    }),
    procurementId: uuid("procurement_id").references(() => procurements.id, {
      onDelete: "set null",
    }),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    uniqueIndex("job_runs_idempotency_key_uq").on(table.idempotencyKey),
    index("job_runs_recovery_idx").on(table.status, table.updatedAt),
    index("job_runs_workspace_idx").on(table.workspaceId),
    check("job_runs_attempt_nonnegative", sql`${table.attempt} >= 0`),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: varchar("request_id", { length: 128 }).notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    procurementId: uuid("procurement_id").references(() => procurements.id, {
      onDelete: "set null",
    }),
    capability: varchar("capability", { length: 128 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    startedAt: timestamptz("started_at").notNull(),
    finishedAt: timestamptz("finished_at"),
    durationMs: integer("duration_ms"),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    index("agent_runs_request_idx").on(table.requestId),
    index("agent_runs_workspace_idx").on(table.workspaceId),
  ],
);

export const agentToolCalls = pgTable("agent_tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  toolName: varchar("tool_name", { length: 128 }).notNull(),
  arguments: jsonb("arguments").notNull(),
  result: jsonb("result"),
  ok: boolean("ok").notNull(),
  errorMessage: text("error_message"),
  startedAt: timestamptz("started_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
});

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    destination: text("destination").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamptz("available_at").notNull().defaultNow(),
    sentAt: timestamptz("sent_at"),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    workspaceId: uuid("workspace_id"),
  },
  (table) => [
    uniqueIndex("notification_outbox_dedupe_uq").on(table.dedupeKey),
    index("notification_outbox_dispatch_idx").on(table.status, table.availableAt),
    index("notification_outbox_workspace_idx").on(table.workspaceId),
  ],
);

/** Console workspace snapshot. Specialist working profiles are data, not DomainProfile rows. */
export const specialistWorkspaces = pgTable("specialist_workspaces", {
  id: varchar("id", { length: 64 }).primaryKey(),
  snapshot: jsonb("snapshot").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

/** Live/fixture specialist cards. Document hashes live on document_versions. */
export const specialistCases = pgTable(
  "specialist_cases",
  {
    id: uuid("id").primaryKey(),
    sourceProcurementId: varchar("source_procurement_id", { length: 256 }).notNull(),
    card: jsonb("card").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("specialist_cases_source_uq").on(table.sourceProcurementId)],
);

/**
 * Console inbox rows. Kept as the console's own JSON so a restart does not
 * lose "new procedure found" rows that point at review cases; dismissed ids
 * stay on the workspace snapshot.
 */
export const specialistInbox = pgTable(
  "specialist_inbox",
  {
    id: uuid("id").primaryKey(),
    procurementId: uuid("procurement_id").notNull(),
    item: jsonb("item").notNull(),
    detectedAt: timestamptz("detected_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("specialist_inbox_procurement_idx").on(table.procurementId)],
);

export const authAccessStatus = pgEnum("auth_access_status", [
  "pending",
  "active",
  "rejected",
  "revoked",
]);

export const authSpecialistRole = pgEnum("auth_specialist_role", [
  "admin",
  "specialist",
  "viewer",
]);

export const authUsers = pgTable(
  "auth_users",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: authSpecialistRole("role"),
    accessStatus: authAccessStatus("access_status").notNull().default("pending"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auth_users_email_uq").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_uq").on(table.tokenHash),
    index("auth_sessions_user_idx").on(table.userId),
  ],
);

export const adminJournalKind = pgEnum("admin_journal_kind", [
  "access",
  "search",
  "documents",
  "discovery",
  "platform",
]);

export const adminJournalLevel = pgEnum("admin_journal_level", ["info", "error"]);

/**
 * Ops/audit log for the admin console. Rows are never deleted and their text is never rewritten;
 * `acknowledged_at` is the single allowed update, so an admin can stop an old error from counting.
 */
export const adminJournal = pgTable(
  "admin_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamptz("at").notNull().defaultNow(),
    kind: adminJournalKind("kind").notNull(),
    level: adminJournalLevel("level").notNull(),
    message: text("message").notNull(),
    actorName: varchar("actor_name", { length: 200 }),
    actorEmail: varchar("actor_email", { length: 320 }),
    sourceProcurementId: varchar("source_procurement_id", { length: 256 }),
    acknowledgedAt: timestamptz("acknowledged_at"),
  },
  (table) => [
    index("admin_journal_at_idx").on(table.at),
    index("admin_journal_level_at_idx").on(table.level, table.at),
    index("admin_journal_open_error_idx").on(table.level, table.acknowledgedAt, table.at),
  ],
);

export const authPasswordResets = pgTable(
  "auth_password_resets",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auth_password_resets_token_uq").on(table.tokenHash)],
);

export const workspaceKind = pgEnum("workspace_kind", ["personal", "team"]);
export const workspaceMemberRole = pgEnum("workspace_member_role", ["owner", "member", "viewer"]);
export const workspaceInboxState = pgEnum("workspace_inbox_state", ["open", "resolved", "dismissed"]);
export const workspaceTriageKind = pgEnum("workspace_triage_kind", ["monitor", "participate", "reject"]);
export const workspaceFoundAs = pgEnum("workspace_found_as", ["match", "review"]);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: workspaceKind("kind").notNull().default("personal"),
    name: varchar("name", { length: 200 }).notNull(),
    createdBy: uuid("created_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("workspaces_created_by_idx").on(table.createdBy)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: workspaceMemberRole("role").notNull().default("owner"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const workspaceProfiles = pgTable(
  "workspace_profiles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull().default(""),
    purpose: text("purpose").notNull().default(""),
    description: text("description").notNull().default(""),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    excludeKeywords: jsonb("exclude_keywords").$type<string[]>().notNull().default([]),
    statuses: jsonb("statuses").$type<string[]>().notNull().default(["accepting_bids"]),
    excludeSingleSource: boolean("exclude_single_source").notNull().default(false),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
    watchNewProcurements: boolean("watch_new_procurements").notNull().default(false),
    lastDiscoveryAt: timestamptz("last_discovery_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [index("workspace_profiles_workspace_idx").on(table.workspaceId)],
);

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  activeProfileId: uuid("active_profile_id").references(() => workspaceProfiles.id, {
    onDelete: "set null",
  }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const workspaceProcurements = pgTable(
  "workspace_procurements",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    procurementId: uuid("procurement_id")
      .notNull()
      .references(() => procurements.id, { onDelete: "restrict" }),
    sourceProcurementId: varchar("source_procurement_id", { length: 256 }).notNull(),
    triage: workspaceTriageKind("triage"),
    foundAs: workspaceFoundAs("found_as"),
    archived: boolean("archived").notNull().default(false),
    lastSeenAt: timestamptz("last_seen_at"),
    watchSnapshot: jsonb("watch_snapshot"),
    card: jsonb("card").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_procurements_workspace_proc_uq").on(
      table.workspaceId,
      table.procurementId,
    ),
    uniqueIndex("workspace_procurements_workspace_source_uq").on(
      table.workspaceId,
      table.sourceProcurementId,
    ),
    index("workspace_procurements_triage_idx").on(table.workspaceId, table.triage, table.archived),
    index("workspace_procurements_seen_idx").on(table.workspaceId, table.lastSeenAt),
  ],
);

export const workspaceProcurementProfiles = pgTable(
  "workspace_procurement_profiles",
  {
    workspaceProcurementId: uuid("workspace_procurement_id")
      .notNull()
      .references(() => workspaceProcurements.id, { onDelete: "cascade" }),
    domainProfileId: uuid("domain_profile_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceProcurementId, table.domainProfileId] })],
);

export const workspaceReviewVerdicts = pgTable(
  "workspace_review_verdicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").notNull(),
    sourceProcurementId: varchar("source_procurement_id", { length: 256 }).notNull(),
    decidedAt: timestamptz("decided_at").notNull(),
    algorithmVersion: varchar("algorithm_version", { length: 64 }).notNull().default("legacy"),
    expiresAt: timestamptz("expires_at"),
  },
  (table) => [
    uniqueIndex("workspace_review_verdicts_uq").on(
      table.workspaceId,
      table.profileId,
      table.sourceProcurementId,
    ),
  ],
);

export const workspaceInbox = pgTable(
  "workspace_inbox",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workspaceProcurementId: uuid("workspace_procurement_id").references(
      () => workspaceProcurements.id,
      { onDelete: "cascade" },
    ),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    item: jsonb("item").notNull(),
    state: workspaceInboxState("state").notNull().default("open"),
    detectedAt: timestamptz("detected_at").notNull(),
    resolvedAt: timestamptz("resolved_at"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_inbox_event_uq").on(table.workspaceId, table.eventKey),
    index("workspace_inbox_case_idx").on(table.workspaceProcurementId),
  ],
);

export const workspaceDecisions = pgTable(
  "workspace_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workspaceProcurementId: uuid("workspace_procurement_id").references(
      () => workspaceProcurements.id,
      { onDelete: "set null" },
    ),
    sourceProcurementId: varchar("source_procurement_id", { length: 256 }).notNull(),
    madeBy: uuid("made_by").references(() => authUsers.id, { onDelete: "set null" }),
    kind: workspaceTriageKind("kind").notNull(),
    comment: text("comment"),
    madeAt: timestamptz("made_at").notNull(),
  },
  (table) => [index("workspace_decisions_workspace_idx").on(table.workspaceId, table.madeAt)],
);

export const workspaceBackfillRuns = pgTable("workspace_backfill_runs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  appliedAt: timestamptz("applied_at").notNull().defaultNow(),
});

/**
 * Telegram link of one console user: chat_id is the delivery address, mode
 * filters which inbox topics reach the chat. Personal cabinets only —
 * workspace membership is not consulted.
 */
export const specialistTelegram = pgTable(
  "specialist_telegram",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    chatId: varchar("chat_id", { length: 32 }).notNull(),
    username: varchar("username", { length: 64 }),
    /** "all" — every urgent inbox event; "urgent" — deadlines/watch changes only. */
    mode: varchar("mode", { length: 16 }).notNull().default("all"),
    linkedAt: timestamptz("linked_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("specialist_telegram_chat_uq").on(table.chatId)],
);

/** One-time link codes issued by POST /api/telegram/link; consumed on /start. */
export const specialistTelegramCodes = pgTable(
  "specialist_telegram_codes",
  {
    code: varchar("code", { length: 32 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("specialist_telegram_codes_user_idx").on(table.userId)],
);

/**
 * At-most-once delivery marker: an inbox event already announced in Telegram
 * never repeats after a restart, and a row dismissed before dispatch is not
 * announced late.
 */
export const specialistTelegramSent = pgTable(
  "specialist_telegram_sent",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    sentAt: timestamptz("sent_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("specialist_telegram_sent_uq").on(table.workspaceId, table.eventKey),
  ],
);
