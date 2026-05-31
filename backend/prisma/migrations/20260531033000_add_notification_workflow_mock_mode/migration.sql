ALTER TABLE "notification_workflows"
  ADD COLUMN IF NOT EXISTS "mock_mode_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "mock_mode_enabled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mock_mode_updated_by" VARCHAR(255);

ALTER TABLE "notification_workflow_runs"
  ADD COLUMN IF NOT EXISTS "execution_mode" VARCHAR(20) NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS "notification_workflow_runs_workspace_id_execution_mode_started_at_idx"
  ON "notification_workflow_runs"("workspace_id", "execution_mode", "started_at");
