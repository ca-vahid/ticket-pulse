-- Add automated daily review configuration
ALTER TABLE "assignment_configs"
ADD COLUMN "daily_review_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "daily_review_run_hour" INTEGER NOT NULL DEFAULT 18,
ADD COLUMN "daily_review_run_minute" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "daily_review_lookback_days" INTEGER NOT NULL DEFAULT 14;

-- Persist full FreshService thread/activity text for analytics
CREATE TABLE "ticket_thread_entries" (
  "id" SERIAL NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "external_entry_id" VARCHAR(191) NOT NULL,
  "source" VARCHAR(50) NOT NULL DEFAULT 'freshservice_activity',
  "event_type" VARCHAR(50) NOT NULL DEFAULT 'activity',
  "actor_name" VARCHAR(255),
  "actor_email" VARCHAR(255),
  "actor_freshservice_id" BIGINT,
  "incoming" BOOLEAN,
  "is_private" BOOLEAN,
  "visibility" VARCHAR(20),
  "title" VARCHAR(255),
  "content" TEXT,
  "body_html" TEXT,
  "body_text" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "raw_payload" JSONB,
  CONSTRAINT "ticket_thread_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_thread_entries_ticket_id_external_entry_id_key"
ON "ticket_thread_entries"("ticket_id", "external_entry_id");

CREATE INDEX "ticket_thread_entries_workspace_id_occurred_at_idx"
ON "ticket_thread_entries"("workspace_id", "occurred_at");

CREATE INDEX "ticket_thread_entries_ticket_id_occurred_at_idx"
ON "ticket_thread_entries"("ticket_id", "occurred_at");

CREATE INDEX "ticket_thread_entries_event_type_idx"
ON "ticket_thread_entries"("event_type");

ALTER TABLE "ticket_thread_entries"
ADD CONSTRAINT "ticket_thread_entries_ticket_id_fkey"
FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ticket_thread_entries"
ADD CONSTRAINT "ticket_thread_entries_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Persist one daily review run per workspace/date
CREATE TABLE "assignment_daily_review_runs" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "review_date" DATE NOT NULL,
  "timezone" VARCHAR(50) NOT NULL,
  "trigger_source" VARCHAR(20) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'running',
  "range_start" TIMESTAMP(3),
  "range_end" TIMESTAMP(3),
  "triggered_by" VARCHAR(255),
  "llm_model" VARCHAR(100),
  "summary_metrics" JSONB,
  "analyzed_ticket_ids" JSONB,
  "evidence_cases" JSONB,
  "prompt_recommendations" JSONB,
  "process_recommendations" JSONB,
  "skill_recommendations" JSONB,
  "warnings" JSONB,
  "total_duration_ms" INTEGER,
  "total_tokens_used" INTEGER,
  "error_message" TEXT,
  "full_transcript" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_daily_review_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assignment_daily_review_runs_workspace_id_review_date_key"
ON "assignment_daily_review_runs"("workspace_id", "review_date");

CREATE INDEX "assignment_daily_review_runs_workspace_id_created_at_idx"
ON "assignment_daily_review_runs"("workspace_id", "created_at");

CREATE INDEX "assignment_daily_review_runs_status_idx"
ON "assignment_daily_review_runs"("status");

ALTER TABLE "assignment_daily_review_runs"
ADD CONSTRAINT "assignment_daily_review_runs_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
