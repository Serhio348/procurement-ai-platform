CREATE TABLE IF NOT EXISTS "specialist_telegram" (
  "user_id" uuid PRIMARY KEY REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "chat_id" varchar(32) NOT NULL,
  "username" varchar(64),
  "mode" varchar(16) NOT NULL DEFAULT 'all',
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "specialist_telegram_chat_uq"
  ON "specialist_telegram" ("chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "specialist_telegram_codes" (
  "code" varchar(32) PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "auth_users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "specialist_telegram_codes_user_idx"
  ON "specialist_telegram_codes" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "specialist_telegram_sent" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "event_key" varchar(255) NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "event_key")
);
