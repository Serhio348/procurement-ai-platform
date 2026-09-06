DO $$ BEGIN
 CREATE TYPE "admin_journal_kind" AS ENUM('access', 'search', 'documents', 'discovery', 'platform');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "admin_journal_level" AS ENUM('info', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_journal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "at" timestamptz NOT NULL DEFAULT now(),
  "kind" "admin_journal_kind" NOT NULL,
  "level" "admin_journal_level" NOT NULL,
  "message" text NOT NULL,
  "actor_name" varchar(200),
  "actor_email" varchar(320),
  "source_procurement_id" varchar(256)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_journal_at_idx" ON "admin_journal" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_journal_level_at_idx" ON "admin_journal" ("level", "at");
