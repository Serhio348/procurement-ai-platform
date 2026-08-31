CREATE TYPE "public"."document_lifecycle" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."investigation_stage" AS ENUM('discovered', 'classified', 'card_fetched', 'waiting_human', 'inactive', 'documents_downloaded', 'documents_extracted', 'commercial_analysed', 'scored', 'reported', 'monitoring', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'waiting_human');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."procedure_status" AS ENUM('announced', 'accepting_bids', 'bidding_closed', 'auction_in_progress', 'under_review', 'completed', 'cancelled', 'unknown');--> statement-breakpoint
CREATE TABLE "activity_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" varchar(128) NOT NULL,
	"task_id" uuid,
	"procurement_id" uuid,
	"capability" varchar(128) NOT NULL,
	"status" varchar(32) NOT NULL,
	"model" varchar(128),
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" varchar(128) NOT NULL,
	"arguments" jsonb NOT NULL,
	"result" jsonb,
	"ok" boolean NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" varchar(255) NOT NULL,
	"procurement_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"field" text,
	"previous" text,
	"current" text,
	"document_id" uuid,
	"previous_version_id" uuid,
	"current_version_id" uuid,
	"detected_at" timestamp with time zone NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"asked_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "party_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"name" text,
	"role" text,
	"phone" text,
	"email" text,
	"raw" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid,
	"task_id" uuid,
	"kind" varchar(32) NOT NULL,
	"made_by" uuid,
	"comment" text,
	"score_snapshot_id" uuid,
	"made_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"downloaded_at" timestamp with time zone NOT NULL,
	"storage_key" text NOT NULL,
	"page_count" integer,
	"extracted_text_length" integer,
	"ocr_applied" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_versions_version_positive" CHECK ("document_versions"."version" > 0),
	CONSTRAINT "document_versions_size_nonnegative" CHECK ("document_versions"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "procurement_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_url" text NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"source_file_key" varchar(128),
	"metadata_url" text,
	"download_url" text,
	"size_bytes" integer,
	"current_version_id" uuid,
	"status" varchar(32) DEFAULT 'discovered' NOT NULL,
	"lifecycle" "document_lifecycle" DEFAULT 'active' NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "procurement_documents_size_nonnegative" CHECK ("procurement_documents"."size_bytes" is null or "procurement_documents"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "domain_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"semantic_concepts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"positive_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"negative_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"formula_id" varchar(128) NOT NULL,
	"formula_version" integer DEFAULT 1 NOT NULL,
	"min_relevance" numeric(4, 3) NOT NULL,
	"min_confidence" numeric(4, 3) NOT NULL,
	"monitoring_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"associated_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"associated_mcp_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_profiles_priority_range" CHECK ("domain_profiles"."priority" between 0 and 100),
	CONSTRAINT "domain_profiles_min_relevance_range" CHECK ("domain_profiles"."min_relevance" between 0 and 1),
	CONSTRAINT "domain_profiles_min_confidence_range" CHECK ("domain_profiles"."min_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"location" jsonb NOT NULL,
	"quote" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_evidence" (
	"fact_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	CONSTRAINT "fact_evidence_fact_id_evidence_id_pk" PRIMARY KEY("fact_id","evidence_id")
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb NOT NULL,
	"unit" varchar(64),
	"confidence" numeric(4, 3) NOT NULL,
	"extracted_by" varchar(128) NOT NULL,
	"extracted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "facts_confidence_range" CHECK ("facts"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "intent_domain_profiles" (
	"intent_id" uuid NOT NULL,
	"domain_profile_id" uuid NOT NULL,
	CONSTRAINT "intent_domain_profiles_intent_id_domain_profile_id_pk" PRIMARY KEY("intent_id","domain_profile_id")
);
--> statement-breakpoint
CREATE TABLE "intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"scope" varchar(32) NOT NULL,
	"raw_message" text NOT NULL,
	"statement" text NOT NULL,
	"procurement_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"supersedes_intent_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(128) NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"attempt" integer DEFAULT 0 NOT NULL,
	"checkpoint" jsonb,
	"request_id" varchar(128),
	"task_id" uuid,
	"intent_id" uuid,
	"domain_profile_id" uuid,
	"procurement_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_attempt_nonnegative" CHECK ("job_runs"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "procurement_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"number" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text,
	"amount" jsonb,
	"quantity" numeric,
	"unit" varchar(64),
	"delivery_place" text,
	"delivery_term" text,
	"funding" text,
	"payment_terms_raw" text,
	"bid_security" text,
	"contract_security" text,
	"okrb_code" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "monitoring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_profile_id" uuid,
	"procurement_id" uuid,
	"watch" varchar(64) NOT NULL,
	"interval_minutes" integer NOT NULL,
	"notify_on_change" boolean DEFAULT true NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_rules_owner_present" CHECK ("monitoring_rules"."domain_profile_id" is not null or "monitoring_rules"."procurement_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"channel" varchar(32) NOT NULL,
	"destination" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "procurement_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"role" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"registration_number" varchar(64),
	"address" text
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"scope" varchar(32) NOT NULL,
	"key" varchar(200) NOT NULL,
	"value" jsonb NOT NULL,
	"statement" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"external_number" varchar(64),
	"title" text NOT NULL,
	"quantity" numeric,
	"unit" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "procurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"source_record_id" varchar(256) NOT NULL,
	"canonical_url" text NOT NULL,
	"page_family" varchar(32),
	"title" text NOT NULL,
	"kind" varchar(64) DEFAULT 'other' NOT NULL,
	"status" "procedure_status" DEFAULT 'unknown' NOT NULL,
	"source_status" text,
	"stage" "investigation_stage" DEFAULT 'discovered' NOT NULL,
	"amount" jsonb,
	"published_at" jsonb,
	"bids_deadline" jsonb,
	"raw_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"relevance" numeric(4, 3),
	"relevance_reason" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" varchar(255) NOT NULL,
	"page_family" varchar(32),
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relevance_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"domain_profile_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_facts" (
	"risk_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	CONSTRAINT "risk_facts_risk_id_fact_id_pk" PRIMARY KEY("risk_id","fact_id")
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"type" varchar(128) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"description" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"detected_by" varchar(128) NOT NULL,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"procurement_id" uuid NOT NULL,
	"formula_id" varchar(128) NOT NULL,
	"formula_version" integer NOT NULL,
	"components" jsonb NOT NULL,
	"weighted_score" numeric(6, 2) NOT NULL,
	"risk_penalty" numeric(6, 2) NOT NULL,
	"final_score" numeric(6, 2) NOT NULL,
	"verdict" varchar(32) NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"explanation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_formulas" (
	"id" varchar(128) NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_formulas_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "scoring_formula_version_positive" CHECK ("scoring_formulas"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "seed_runs" (
	"seed_id" varchar(128) PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"domain_profile_id" uuid,
	"procurement_id" uuid,
	"monitoring_rule_id" uuid,
	"type" varchar(32) NOT NULL,
	"status" varchar(32) NOT NULL,
	"scope" varchar(32) NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"schedule" jsonb,
	"title" varchar(300) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	CONSTRAINT "tasks_priority_range" CHECK ("tasks"."priority" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "activity_assessments" ADD CONSTRAINT "activity_assessments_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_document_id_procurement_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."procurement_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_previous_version_id_document_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_clarifications" ADD CONSTRAINT "procurement_clarifications_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_contacts" ADD CONSTRAINT "party_contacts_party_id_procurement_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."procurement_parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_score_snapshot_id_score_snapshots_id_fk" FOREIGN KEY ("score_snapshot_id") REFERENCES "public"."score_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_procurement_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."procurement_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_documents" ADD CONSTRAINT "procurement_documents_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_profiles" ADD CONSTRAINT "domain_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_external_ids" ADD CONSTRAINT "procurement_external_ids_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_domain_profiles" ADD CONSTRAINT "intent_domain_profiles_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_domain_profiles" ADD CONSTRAINT "intent_domain_profiles_domain_profile_id_domain_profiles_id_fk" FOREIGN KEY ("domain_profile_id") REFERENCES "public"."domain_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intents" ADD CONSTRAINT "intents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_domain_profile_id_domain_profiles_id_fk" FOREIGN KEY ("domain_profile_id") REFERENCES "public"."domain_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_lots" ADD CONSTRAINT "procurement_lots_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_rules" ADD CONSTRAINT "monitoring_rules_domain_profile_id_domain_profiles_id_fk" FOREIGN KEY ("domain_profile_id") REFERENCES "public"."domain_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_rules" ADD CONSTRAINT "monitoring_rules_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_parties" ADD CONSTRAINT "procurement_parties_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_positions" ADD CONSTRAINT "lot_positions_lot_id_procurement_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."procurement_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_artifacts" ADD CONSTRAINT "raw_artifacts_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relevance_assessments" ADD CONSTRAINT "relevance_assessments_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relevance_assessments" ADD CONSTRAINT "relevance_assessments_domain_profile_id_domain_profiles_id_fk" FOREIGN KEY ("domain_profile_id") REFERENCES "public"."domain_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_facts" ADD CONSTRAINT "risk_facts_risk_id_risks_id_fk" FOREIGN KEY ("risk_id") REFERENCES "public"."risks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_facts" ADD CONSTRAINT "risk_facts_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_snapshots" ADD CONSTRAINT "score_snapshots_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_domain_profile_id_domain_profiles_id_fk" FOREIGN KEY ("domain_profile_id") REFERENCES "public"."domain_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_procurement_id_procurements_id_fk" FOREIGN KEY ("procurement_id") REFERENCES "public"."procurements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_monitoring_rule_id_monitoring_rules_id_fk" FOREIGN KEY ("monitoring_rule_id") REFERENCES "public"."monitoring_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_request_idx" ON "agent_runs" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_procurement_key_uq" ON "change_events" USING btree ("procurement_id","event_key");--> statement-breakpoint
CREATE INDEX "change_events_detected_idx" ON "change_events" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_number_uq" ON "document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_hash_uq" ON "document_versions" USING btree ("document_id","hash");--> statement-breakpoint
CREATE INDEX "document_versions_hash_idx" ON "document_versions" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "procurement_documents_procurement_idx" ON "procurement_documents" USING btree ("procurement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_profiles_company_slug_uq" ON "domain_profiles" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "domain_profiles_active_idx" ON "domain_profiles" USING btree ("company_id","enabled","archived");--> statement-breakpoint
CREATE INDEX "evidence_procurement_idx" ON "evidence" USING btree ("procurement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_external_ids_uq" ON "procurement_external_ids" USING btree ("procurement_id","kind","value");--> statement-breakpoint
CREATE INDEX "facts_procurement_key_idx" ON "facts" USING btree ("procurement_id","key");--> statement-breakpoint
CREATE INDEX "intents_company_active_idx" ON "intents" USING btree ("company_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_idempotency_key_uq" ON "job_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_runs_recovery_idx" ON "job_runs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_lots_number_uq" ON "procurement_lots" USING btree ("procurement_id","number");--> statement-breakpoint
CREATE INDEX "monitoring_rules_active_idx" ON "monitoring_rules" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_uq" ON "notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_dispatch_idx" ON "notification_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "procurement_parties_procurement_idx" ON "procurement_parties" USING btree ("procurement_id");--> statement-breakpoint
CREATE INDEX "policies_scope_key_idx" ON "policies" USING btree ("scope","key","active");--> statement-breakpoint
CREATE INDEX "lot_positions_lot_idx" ON "lot_positions" USING btree ("lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "procurements_source_record_uq" ON "procurements" USING btree ("source_id","source_record_id");--> statement-breakpoint
CREATE INDEX "procurements_status_stage_idx" ON "procurements" USING btree ("status","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_artifacts_procurement_hash_uq" ON "raw_artifacts" USING btree ("procurement_id","hash");--> statement-breakpoint
CREATE INDEX "raw_artifacts_hash_idx" ON "raw_artifacts" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "score_snapshots_procurement_computed_idx" ON "score_snapshots" USING btree ("procurement_id","computed_at");--> statement-breakpoint
CREATE INDEX "tasks_status_type_idx" ON "tasks" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "tasks_next_run_idx" ON "tasks" USING btree ("next_run_at");--> statement-breakpoint
ALTER TABLE "procurement_documents"
  ADD CONSTRAINT "procurement_documents_current_version_fk"
  FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id")
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "domain_profiles"
  ADD CONSTRAINT "domain_profiles_formula_fk"
  FOREIGN KEY ("formula_id", "formula_version")
  REFERENCES "scoring_formulas"("id", "version")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "score_snapshots"
  ADD CONSTRAINT "score_snapshots_formula_fk"
  FOREIGN KEY ("formula_id", "formula_version")
  REFERENCES "scoring_formulas"("id", "version")
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "intents"
  ADD CONSTRAINT "intents_supersedes_intent_fk"
  FOREIGN KEY ("supersedes_intent_id") REFERENCES "intents"("id")
  ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "intents"
  ADD CONSTRAINT "intents_procurement_fk"
  FOREIGN KEY ("procurement_id") REFERENCES "procurements"("id")
  ON DELETE SET NULL;--> statement-breakpoint
CREATE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER change_events_append_only
  BEFORE UPDATE OR DELETE ON "change_events"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER decisions_append_only
  BEFORE UPDATE OR DELETE ON "decisions"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();--> statement-breakpoint
CREATE FUNCTION ensure_fact_has_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_fact_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'facts' THEN
    target_fact_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_fact_id := COALESCE(NEW.fact_id, OLD.fact_id);
  END IF;

  IF EXISTS (SELECT 1 FROM facts WHERE id = target_fact_id)
     AND NOT EXISTS (SELECT 1 FROM fact_evidence WHERE fact_id = target_fact_id) THEN
    RAISE EXCEPTION 'fact % must cite at least one evidence', target_fact_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER facts_require_evidence
  AFTER INSERT OR UPDATE ON "facts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_fact_has_evidence();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER fact_evidence_cannot_orphan_fact
  AFTER UPDATE OR DELETE ON "fact_evidence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_fact_has_evidence();--> statement-breakpoint
CREATE FUNCTION ensure_risk_has_fact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_risk_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'risks' THEN
    target_risk_id := COALESCE(NEW.id, OLD.id);
  ELSE
    target_risk_id := COALESCE(NEW.risk_id, OLD.risk_id);
  END IF;

  IF EXISTS (SELECT 1 FROM risks WHERE id = target_risk_id)
     AND NOT EXISTS (SELECT 1 FROM risk_facts WHERE risk_id = target_risk_id) THEN
    RAISE EXCEPTION 'risk % must cite at least one fact', target_risk_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER risks_require_facts
  AFTER INSERT OR UPDATE ON "risks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_risk_has_fact();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER risk_facts_cannot_orphan_risk
  AFTER UPDATE OR DELETE ON "risk_facts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_risk_has_fact();