CREATE TABLE IF NOT EXISTS "workspace_assistant_suggestions" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "profile_id" uuid NOT NULL,
  "term_key" varchar(256) NOT NULL,
  "label" varchar(256) NOT NULL,
  "reject_count" integer NOT NULL,
  "examples" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "state" varchar(16) NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL,
  "resolved_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_assistant_suggestions_term_uq"
  ON "workspace_assistant_suggestions" ("workspace_id", "profile_id", "term_key");
