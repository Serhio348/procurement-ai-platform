CREATE TABLE IF NOT EXISTS "workspace_decision_memory" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "source_procurement_id" varchar(256) NOT NULL,
  "kind" "workspace_triage_kind" NOT NULL,
  "profile_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "title" text NOT NULL,
  "lot_titles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "decided_at" timestamptz NOT NULL,
  PRIMARY KEY ("workspace_id", "source_procurement_id")
);
