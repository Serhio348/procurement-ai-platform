ALTER TABLE "workspace_review_verdicts"
  ADD COLUMN IF NOT EXISTS "algorithm_version" varchar(64) NOT NULL DEFAULT 'legacy';
