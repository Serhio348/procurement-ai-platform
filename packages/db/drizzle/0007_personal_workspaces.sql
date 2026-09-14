CREATE TYPE "workspace_kind" AS ENUM('personal', 'team');
--> statement-breakpoint
CREATE TYPE "workspace_member_role" AS ENUM('owner', 'member', 'viewer');
--> statement-breakpoint
CREATE TYPE "workspace_inbox_state" AS ENUM('open', 'resolved', 'dismissed');
--> statement-breakpoint
CREATE TYPE "workspace_triage_kind" AS ENUM('monitor', 'participate', 'reject');
--> statement-breakpoint
CREATE TYPE "workspace_found_as" AS ENUM('match', 'review');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" "workspace_kind" NOT NULL DEFAULT 'personal',
  "name" varchar(200) NOT NULL,
  "created_by" uuid REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_created_by_idx" ON "workspaces" ("created_by");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_one_personal_per_user"
  ON "workspaces" ("created_by")
  WHERE "kind" = 'personal' AND "created_by" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_members" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "role" "workspace_member_role" NOT NULL DEFAULT 'owner',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_profiles" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL DEFAULT '',
  "purpose" text NOT NULL DEFAULT '',
  "description" text NOT NULL DEFAULT '',
  "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "exclude_keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "statuses" jsonb NOT NULL DEFAULT '["accepting_bids"]'::jsonb,
  "exclude_single_source" boolean NOT NULL DEFAULT false,
  "filters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "watch_new_procurements" boolean NOT NULL DEFAULT false,
  "last_discovery_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_profiles_workspace_idx" ON "workspace_profiles" ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_settings" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "active_profile_id" uuid REFERENCES "workspace_profiles"("id") ON DELETE SET NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_procurements" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "procurement_id" uuid NOT NULL REFERENCES "procurements"("id") ON DELETE RESTRICT,
  "source_procurement_id" varchar(256) NOT NULL,
  "triage" "workspace_triage_kind",
  "found_as" "workspace_found_as",
  "archived" boolean NOT NULL DEFAULT false,
  "last_seen_at" timestamptz,
  "watch_snapshot" jsonb,
  "card" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_procurements_workspace_proc_uq"
  ON "workspace_procurements" ("workspace_id", "procurement_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_procurements_workspace_source_uq"
  ON "workspace_procurements" ("workspace_id", "source_procurement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_procurements_triage_idx"
  ON "workspace_procurements" ("workspace_id", "triage", "archived");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_procurements_seen_idx"
  ON "workspace_procurements" ("workspace_id", "last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_procurement_profiles" (
  "workspace_procurement_id" uuid NOT NULL REFERENCES "workspace_procurements"("id") ON DELETE CASCADE,
  "domain_profile_id" uuid NOT NULL,
  PRIMARY KEY ("workspace_procurement_id", "domain_profile_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_review_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL,
  "source_procurement_id" varchar(256) NOT NULL,
  "decided_at" timestamptz NOT NULL,
  "expires_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_review_verdicts_uq"
  ON "workspace_review_verdicts" ("workspace_id", "profile_id", "source_procurement_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_inbox" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "workspace_procurement_id" uuid REFERENCES "workspace_procurements"("id") ON DELETE CASCADE,
  "event_key" varchar(255) NOT NULL,
  "item" jsonb NOT NULL,
  "state" "workspace_inbox_state" NOT NULL DEFAULT 'open',
  "detected_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_inbox_event_uq"
  ON "workspace_inbox" ("workspace_id", "event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_inbox_case_idx" ON "workspace_inbox" ("workspace_procurement_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "workspace_procurement_id" uuid REFERENCES "workspace_procurements"("id") ON DELETE SET NULL,
  "source_procurement_id" varchar(256) NOT NULL,
  "made_by" uuid REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "kind" "workspace_triage_kind" NOT NULL,
  "comment" text,
  "made_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_decisions_workspace_idx"
  ON "workspace_decisions" ("workspace_id", "made_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_backfill_runs" (
  "id" varchar(64) PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "domain_profiles" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "domain_profiles" ADD COLUMN IF NOT EXISTS "search_config" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_profiles_workspace_idx" ON "domain_profiles" ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "domain_profiles_workspace_slug_uq"
  ON "domain_profiles" ("workspace_id", "slug");
--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facts_workspace_idx" ON "facts" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "risks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risks_workspace_idx" ON "risks" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "score_snapshots" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "score_snapshots_workspace_idx" ON "score_snapshots" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "monitoring_rules" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitoring_rules_workspace_idx" ON "monitoring_rules" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_idx" ON "tasks" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_workspace_idx" ON "job_runs" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_workspace_idx" ON "agent_runs" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_workspace_idx" ON "notification_outbox" ("workspace_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION workspace_rls_visible(target_workspace uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      target_workspace IS NOT NULL
      AND target_workspace::text = current_setting('app.workspace_id', true)
    );
$$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspaces_isolation" ON "workspaces";
--> statement-breakpoint
CREATE POLICY "workspaces_isolation" ON "workspaces"
  USING (
    workspace_rls_visible("id")
    OR (
      current_setting('app.user_id', true) <> ''
      AND EXISTS (
        SELECT 1
        FROM "workspace_members" m
        WHERE m.workspace_id = "workspaces"."id"
          AND m.user_id::text = current_setting('app.user_id', true)
      )
    )
  )
  WITH CHECK (workspace_rls_visible("id"));
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_members_isolation" ON "workspace_members";
--> statement-breakpoint
CREATE POLICY "workspace_members_isolation" ON "workspace_members"
  USING (
    workspace_rls_visible("workspace_id")
    OR (
      current_setting('app.user_id', true) <> ''
      AND "user_id"::text = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    workspace_rls_visible("workspace_id")
    OR (
      current_setting('app.user_id', true) <> ''
      AND "user_id"::text = current_setting('app.user_id', true)
    )
  );
--> statement-breakpoint
ALTER TABLE "workspace_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_profiles_isolation" ON "workspace_profiles";
--> statement-breakpoint
CREATE POLICY "workspace_profiles_isolation" ON "workspace_profiles"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
--> statement-breakpoint
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_settings_isolation" ON "workspace_settings";
--> statement-breakpoint
CREATE POLICY "workspace_settings_isolation" ON "workspace_settings"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
--> statement-breakpoint
ALTER TABLE "workspace_procurements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_procurements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_procurements_isolation" ON "workspace_procurements";
--> statement-breakpoint
CREATE POLICY "workspace_procurements_isolation" ON "workspace_procurements"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
--> statement-breakpoint
ALTER TABLE "workspace_procurement_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_procurement_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_procurement_profiles_isolation" ON "workspace_procurement_profiles";
--> statement-breakpoint
CREATE POLICY "workspace_procurement_profiles_isolation" ON "workspace_procurement_profiles"
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1
      FROM "workspace_procurements" wp
      WHERE wp.id = "workspace_procurement_id"
        AND workspace_rls_visible(wp.workspace_id)
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1
      FROM "workspace_procurements" wp
      WHERE wp.id = "workspace_procurement_id"
        AND workspace_rls_visible(wp.workspace_id)
    )
  );
--> statement-breakpoint
ALTER TABLE "workspace_review_verdicts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_review_verdicts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_review_verdicts_isolation" ON "workspace_review_verdicts";
--> statement-breakpoint
CREATE POLICY "workspace_review_verdicts_isolation" ON "workspace_review_verdicts"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
--> statement-breakpoint
ALTER TABLE "workspace_inbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_inbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_inbox_isolation" ON "workspace_inbox";
--> statement-breakpoint
CREATE POLICY "workspace_inbox_isolation" ON "workspace_inbox"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
--> statement-breakpoint
ALTER TABLE "workspace_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_decisions_isolation" ON "workspace_decisions";
--> statement-breakpoint
CREATE POLICY "workspace_decisions_isolation" ON "workspace_decisions"
  USING (workspace_rls_visible("workspace_id"))
  WITH CHECK (workspace_rls_visible("workspace_id"));
