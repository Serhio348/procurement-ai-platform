ALTER TABLE "admin_journal" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_journal_open_error_idx" ON "admin_journal" ("level","acknowledged_at","at");
