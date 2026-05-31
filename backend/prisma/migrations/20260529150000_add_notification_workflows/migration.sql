-- Workspace-scoped configurable notification workflows and generic email deliveries.

CREATE TABLE "notification_workflows" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "trigger_type" VARCHAR(60) NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT false,
  "enabled_at" TIMESTAMP(3),
  "draft_definition" JSONB NOT NULL,
  "published_definition" JSONB,
  "published_version" INTEGER NOT NULL DEFAULT 0,
  "last_published_at" TIMESTAMP(3),
  "last_changed_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_workflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_workflows_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_workflows_workspace_id_key_key"
  ON "notification_workflows"("workspace_id", "key");

CREATE INDEX "notification_workflows_workspace_id_trigger_type_is_enabled_idx"
  ON "notification_workflows"("workspace_id", "trigger_type", "is_enabled");

CREATE TABLE "notification_workflow_versions" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "workflow_id" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "validation_result" JSONB,
  "change_note" TEXT,
  "published_by" VARCHAR(255),
  "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_workflow_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_workflow_versions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_workflow_versions_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "notification_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_workflow_versions_workflow_id_version_key"
  ON "notification_workflow_versions"("workflow_id", "version");

CREATE INDEX "notification_workflow_versions_workspace_id_workflow_id_idx"
  ON "notification_workflow_versions"("workspace_id", "workflow_id");

CREATE TABLE "notification_workflow_runs" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "workflow_id" INTEGER NOT NULL,
  "workflow_version_id" INTEGER,
  "ticket_id" INTEGER,
  "event_type" VARCHAR(60) NOT NULL,
  "event_context" JSONB NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'running',
  "trigger_source" VARCHAR(80),
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "duration_ms" INTEGER,
  "error" TEXT,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "dry_run" BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT "notification_workflow_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_workflow_runs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_workflow_runs_workflow_id_fkey"
    FOREIGN KEY ("workflow_id") REFERENCES "notification_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_workflow_runs_workflow_version_id_fkey"
    FOREIGN KEY ("workflow_version_id") REFERENCES "notification_workflow_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "notification_workflow_runs_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_workflow_runs_dedupe_key_key"
  ON "notification_workflow_runs"("dedupe_key");

CREATE INDEX "notification_workflow_runs_workspace_id_event_type_started_at_idx"
  ON "notification_workflow_runs"("workspace_id", "event_type", "started_at");

CREATE INDEX "notification_workflow_runs_workflow_id_started_at_idx"
  ON "notification_workflow_runs"("workflow_id", "started_at");

CREATE INDEX "notification_workflow_runs_ticket_id_idx"
  ON "notification_workflow_runs"("ticket_id");

CREATE INDEX "notification_workflow_runs_status_idx"
  ON "notification_workflow_runs"("status");

CREATE TABLE "notification_workflow_step_runs" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "run_id" INTEGER NOT NULL,
  "node_id" VARCHAR(120) NOT NULL,
  "node_type" VARCHAR(60) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'running',
  "input" JSONB,
  "output" JSONB,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "duration_ms" INTEGER,
  "error" TEXT,

  CONSTRAINT "notification_workflow_step_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_workflow_step_runs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_workflow_step_runs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "notification_workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_workflow_step_runs_workspace_id_run_id_idx"
  ON "notification_workflow_step_runs"("workspace_id", "run_id");

CREATE INDEX "notification_workflow_step_runs_run_id_node_id_idx"
  ON "notification_workflow_step_runs"("run_id", "node_id");

CREATE INDEX "notification_workflow_step_runs_status_idx"
  ON "notification_workflow_step_runs"("status");

ALTER TABLE "ai_provider_attempts"
  ADD COLUMN "notification_workflow_run_id" INTEGER;

ALTER TABLE "ai_provider_attempts"
  ADD CONSTRAINT "ai_provider_attempts_notification_workflow_run_id_fkey"
  FOREIGN KEY ("notification_workflow_run_id") REFERENCES "notification_workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ai_provider_attempts_notification_workflow_run_id_idx"
  ON "ai_provider_attempts"("notification_workflow_run_id");

ALTER TABLE "notification_deliveries"
  ALTER COLUMN "assessed_priority" DROP NOT NULL,
  ADD COLUMN "workflow_run_id" INTEGER,
  ADD COLUMN "workflow_step_run_id" INTEGER,
  ADD COLUMN "event_type" VARCHAR(60),
  ADD COLUMN "notification_type" VARCHAR(80),
  ADD COLUMN "to_recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "cc_recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bcc_recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "html_body" TEXT,
  ADD COLUMN "text_body" TEXT,
  ADD COLUMN "from_address" VARCHAR(255);

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_workflow_run_id_fkey"
  FOREIGN KEY ("workflow_run_id") REFERENCES "notification_workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_workflow_step_run_id_fkey"
  FOREIGN KEY ("workflow_step_run_id") REFERENCES "notification_workflow_step_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "notification_deliveries_workflow_run_id_idx"
  ON "notification_deliveries"("workflow_run_id");

CREATE INDEX "notification_deliveries_workflow_step_run_id_idx"
  ON "notification_deliveries"("workflow_step_run_id");

CREATE INDEX "notification_deliveries_event_type_idx"
  ON "notification_deliveries"("event_type");

CREATE INDEX "notification_deliveries_notification_type_idx"
  ON "notification_deliveries"("notification_type");
