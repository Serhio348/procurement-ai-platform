-- The madeAt dedup key compared a Postgres timestamptz string with an ISO
-- string, so it never matched: every save re-inserted the entire decision
-- history and the table grew quadratically (hundreds of thousands of
-- duplicate rows). Remove every copy but one per
-- (workspace, procurement, kind, made_at), then lock the shape with a
-- unique index so the insert path can rely on ON CONFLICT DO NOTHING.

DELETE FROM "workspace_decisions" a
  USING "workspace_decisions" b
WHERE a."ctid" < b."ctid"
  AND a."workspace_id" = b."workspace_id"
  AND a."source_procurement_id" = b."source_procurement_id"
  AND a."kind" = b."kind"
  AND a."made_at" = b."made_at";

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_decisions_dedupe_idx"
  ON "workspace_decisions" (
    "workspace_id",
    "source_procurement_id",
    "kind",
    "made_at"
  );
