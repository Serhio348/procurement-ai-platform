-- Cards left behind by a deleted profile. An undecided row whose every
-- profile link is gone has nobody to review it; a decision or a live
-- profile keeps the row. The shared procurements catalogue is not touched,
-- so another cabinet's copy of the same procedure stays.
DELETE FROM "workspace_inbox"
WHERE "workspace_procurement_id" IN (
  SELECT wp."id"
  FROM "workspace_procurements" wp
  WHERE wp."triage" IS NULL
    AND wp."archived" = false
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_decisions" decision
      WHERE decision."workspace_id" = wp."workspace_id"
        AND decision."source_procurement_id" = wp."source_procurement_id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_procurement_profiles" link
      JOIN "workspace_profiles" profile ON profile."id" = link."domain_profile_id"
      WHERE link."workspace_procurement_id" = wp."id"
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "workspace_procurement_profiles" link
        WHERE link."workspace_procurement_id" = wp."id"
          AND NOT EXISTS (
            SELECT 1 FROM "workspace_profiles" profile WHERE profile."id" = link."domain_profile_id"
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(wp."card"->'profileIds', '[]'::jsonb)) AS pid(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = pid.value
        )
      )
    )
);
--> statement-breakpoint
DELETE FROM "workspace_procurement_profiles"
WHERE "workspace_procurement_id" IN (
  SELECT wp."id"
  FROM "workspace_procurements" wp
  WHERE wp."triage" IS NULL
    AND wp."archived" = false
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_decisions" decision
      WHERE decision."workspace_id" = wp."workspace_id"
        AND decision."source_procurement_id" = wp."source_procurement_id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "workspace_procurement_profiles" link
      JOIN "workspace_profiles" profile ON profile."id" = link."domain_profile_id"
      WHERE link."workspace_procurement_id" = wp."id"
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "workspace_procurement_profiles" link
        WHERE link."workspace_procurement_id" = wp."id"
          AND NOT EXISTS (
            SELECT 1 FROM "workspace_profiles" profile WHERE profile."id" = link."domain_profile_id"
          )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(wp."card"->'profileIds', '[]'::jsonb)) AS pid(value)
        WHERE NOT EXISTS (
          SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = pid.value
        )
      )
    )
);
--> statement-breakpoint
DELETE FROM "workspace_procurements"
WHERE "triage" IS NULL
  AND "archived" = false
  AND NOT EXISTS (
    SELECT 1
    FROM "workspace_decisions" decision
    WHERE decision."workspace_id" = "workspace_procurements"."workspace_id"
      AND decision."source_procurement_id" = "workspace_procurements"."source_procurement_id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "workspace_procurement_profiles" link
    JOIN "workspace_profiles" profile ON profile."id" = link."domain_profile_id"
    WHERE link."workspace_procurement_id" = "workspace_procurements"."id"
  )
  AND (
    EXISTS (
      SELECT 1
      FROM "workspace_procurement_profiles" link
      WHERE link."workspace_procurement_id" = "workspace_procurements"."id"
        AND NOT EXISTS (
          SELECT 1 FROM "workspace_profiles" profile WHERE profile."id" = link."domain_profile_id"
        )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(COALESCE("card"->'profileIds', '[]'::jsonb)) AS pid(value)
      WHERE NOT EXISTS (
        SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = pid.value
      )
    )
  );
--> statement-breakpoint
DELETE FROM "workspace_procurement_profiles" AS link
WHERE NOT EXISTS (
  SELECT 1 FROM "workspace_profiles" profile WHERE profile."id" = link."domain_profile_id"
);
--> statement-breakpoint
UPDATE "workspace_procurements" AS wp
SET "card" = jsonb_set(
  COALESCE(wp."card", '{}'::jsonb),
  '{profileIds}',
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(pid.value))
      FROM jsonb_array_elements_text(COALESCE(wp."card"->'profileIds', '[]'::jsonb)) AS pid(value)
      WHERE EXISTS (
        SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = pid.value
      )
    ),
    '[]'::jsonb
  )
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(COALESCE(wp."card"->'profileIds', '[]'::jsonb)) AS pid(value)
  WHERE NOT EXISTS (
    SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = pid.value
  )
);
--> statement-breakpoint
UPDATE "workspace_procurements" AS wp
SET "card" = jsonb_set(
  COALESCE(wp."card", '{}'::jsonb),
  '{assessments}',
  COALESCE(
    (
      SELECT jsonb_object_agg(entry.key, entry.value)
      FROM jsonb_each(COALESCE(wp."card"->'assessments', '{}'::jsonb)) AS entry
      WHERE EXISTS (
        SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = entry.key
      )
    ),
    '{}'::jsonb
  )
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_each(COALESCE(wp."card"->'assessments', '{}'::jsonb)) AS entry
  WHERE NOT EXISTS (
    SELECT 1 FROM "workspace_profiles" profile WHERE profile."id"::text = entry.key
  )
);
