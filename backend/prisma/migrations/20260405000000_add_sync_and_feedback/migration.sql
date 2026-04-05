-- Sync and feedback fields for assignment pipeline

-- AssignmentPromptVersion table (versioned prompts for assignment pipeline)
CREATE TABLE IF NOT EXISTS "assignment_prompt_versions" (
    "id" SERIAL PRIMARY KEY,
    "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id"),
    "version" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "system_prompt" TEXT NOT NULL,
    "tool_config" JSONB,
    "created_by" VARCHAR(255),
    "published_by" VARCHAR(255),
    "published_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("workspace_id", "version")
);

CREATE INDEX IF NOT EXISTS "assignment_prompt_versions_workspace_id_idx" ON "assignment_prompt_versions"("workspace_id");
CREATE INDEX IF NOT EXISTS "assignment_prompt_versions_status_idx" ON "assignment_prompt_versions"("status");

-- Add missing columns to assignment_pipeline_runs
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "full_transcript" TEXT;
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "prompt_version_id" INTEGER;
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "sync_status" VARCHAR(20);
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "synced_at" TIMESTAMP(3);
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "sync_error" TEXT;
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "sync_payload" JSONB;
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "feedback_applied" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "assignment_pipeline_runs"
    ADD CONSTRAINT "assignment_pipeline_runs_prompt_version_id_fkey"
    FOREIGN KEY ("prompt_version_id") REFERENCES "assignment_prompt_versions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Add missing columns to assignment_configs
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "monitored_mailbox" VARCHAR(255);
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "email_polling_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "email_polling_interval_sec" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "last_email_check_at" TIMESTAMP(3);
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "auto_close_noise" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "dry_run_mode" BOOLEAN NOT NULL DEFAULT true;
