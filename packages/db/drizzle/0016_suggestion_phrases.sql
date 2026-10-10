ALTER TABLE "workspace_assistant_suggestions"
  ADD COLUMN IF NOT EXISTS "phrases" jsonb NOT NULL DEFAULT '[]'::jsonb;
