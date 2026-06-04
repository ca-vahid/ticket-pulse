ALTER TABLE "notification_workflows"
  ADD COLUMN IF NOT EXISTS "routing_mode" VARCHAR(20) NOT NULL DEFAULT 'exclusive',
  ADD COLUMN IF NOT EXISTS "routing_priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "routing_rule" JSONB,
  ADD COLUMN IF NOT EXISTS "is_default_variant" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archived_by" VARCHAR(255);

ALTER TABLE "notification_workflow_runs"
  ADD COLUMN IF NOT EXISTS "routing_result" JSONB;

UPDATE "notification_workflows"
SET
  "routing_mode" = COALESCE(NULLIF("routing_mode", ''), 'exclusive'),
  "routing_priority" = CASE
    WHEN "key" = 'ticket_created_after_hours' THEN 20
    WHEN "routing_priority" IS NULL THEN 100
    ELSE "routing_priority"
  END,
  "is_default_variant" = TRUE
WHERE "key" IN (
  'ticket_created',
  'ticket_created_after_hours',
  'ticket_assigned',
  'ticket_reassigned',
  'ticket_resolved_closed'
);

CREATE INDEX IF NOT EXISTS "notification_workflows_workspace_trigger_archived_idx"
  ON "notification_workflows"("workspace_id", "trigger_type", "archived_at");

CREATE INDEX IF NOT EXISTS "notification_workflows_workspace_trigger_enabled_priority_idx"
  ON "notification_workflows"("workspace_id", "trigger_type", "is_enabled", "routing_priority");
