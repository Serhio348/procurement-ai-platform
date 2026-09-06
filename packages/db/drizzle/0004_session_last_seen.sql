ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
UPDATE "auth_sessions" SET "last_seen_at" = "created_at";
