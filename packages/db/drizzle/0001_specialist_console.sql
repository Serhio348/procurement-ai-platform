CREATE TABLE IF NOT EXISTS "specialist_workspaces" (
  "id" varchar(64) PRIMARY KEY,
  "snapshot" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "specialist_cases" (
  "id" uuid PRIMARY KEY,
  "source_procurement_id" varchar(256) NOT NULL,
  "card" jsonb NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_cases_source_uq" ON "specialist_cases" ("source_procurement_id");
