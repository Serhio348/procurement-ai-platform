DELETE FROM "workspace_decisions"
WHERE "ctid" NOT IN (
  SELECT min("ctid")
  FROM "workspace_decisions"
  GROUP BY "workspace_id", "source_procurement_id", "kind", "made_at"
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_decisions_dedupe_idx"
  ON "workspace_decisions" (
    "workspace_id",
    "source_procurement_id",
    "kind",
    "made_at"
  );
