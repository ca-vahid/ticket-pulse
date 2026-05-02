-- Scope the existing default noise rules to the IT workspace only.
-- Non-IT workspaces should start with empty rules so their noise profile can be built independently.

WITH default_workspace AS (
  SELECT COALESCE(
    (SELECT "id" FROM "workspaces" WHERE "slug" = 'it' ORDER BY "id" ASC LIMIT 1),
    1
  ) AS "id"
)
DELETE FROM "noise_rules"
WHERE "workspace_id" <> (SELECT "id" FROM default_workspace);

WITH default_workspace AS (
  SELECT COALESCE(
    (SELECT "id" FROM "workspaces" WHERE "slug" = 'it' ORDER BY "id" ASC LIMIT 1),
    1
  ) AS "id"
)
UPDATE "tickets"
SET
  "is_noise" = false,
  "noise_rule_matched" = NULL
WHERE "workspace_id" <> (SELECT "id" FROM default_workspace)
  AND (
    "is_noise" = true
    OR "noise_rule_matched" IS NOT NULL
  );
