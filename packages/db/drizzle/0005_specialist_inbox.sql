CREATE TABLE IF NOT EXISTS "specialist_inbox" (
  "id" uuid PRIMARY KEY,
  "procurement_id" uuid NOT NULL,
  "item" jsonb NOT NULL,
  "detected_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_inbox_procurement_idx" ON "specialist_inbox" ("procurement_id");
