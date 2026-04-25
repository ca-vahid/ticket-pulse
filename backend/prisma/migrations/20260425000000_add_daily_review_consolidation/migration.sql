CREATE TABLE "assignment_daily_review_consolidation_runs" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'collecting',
  "phase" VARCHAR(40),
  "triggered_by" VARCHAR(255),
  "llm_model" VARCHAR(100),
  "source_recommendation_ids" JSONB,
  "source_counts" JSONB,
  "context_snapshot" JSONB,
  "raw_result" JSONB,
  "section_selection" JSONB,
  "prompt_draft_id" INTEGER,
  "total_tokens_used" INTEGER,
  "total_duration_ms" INTEGER,
  "error_message" TEXT,
  "progress" JSONB,
  "completed_at" TIMESTAMP(3),
  "applied_by" VARCHAR(255),
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assignment_daily_review_consolidation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assignment_daily_review_consolidation_items" (
  "id" SERIAL NOT NULL,
  "run_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "section" VARCHAR(40) NOT NULL,
  "action_type" VARCHAR(40),
  "title" VARCHAR(255) NOT NULL,
  "rationale" TEXT,
  "payload" JSONB,
  "edited_payload" JSONB,
  "source_recommendation_ids" JSONB,
  "include_in_apply" BOOLEAN NOT NULL DEFAULT true,
  "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
  "apply_result" JSONB,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assignment_daily_review_consolidation_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assignment_daily_review_consolidation_events" (
  "id" SERIAL NOT NULL,
  "run_id" INTEGER NOT NULL,
  "type" VARCHAR(40) NOT NULL,
  "message" TEXT,
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_daily_review_consolidation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assignment_daily_review_consolidation_runs_workspace_id_idx" ON "assignment_daily_review_consolidation_runs"("workspace_id");
CREATE INDEX "assignment_daily_review_consolidation_runs_status_idx" ON "assignment_daily_review_consolidation_runs"("status");
CREATE INDEX "assignment_daily_review_consolidation_runs_created_at_idx" ON "assignment_daily_review_consolidation_runs"("created_at");

CREATE INDEX "assignment_daily_review_consolidation_items_run_id_idx" ON "assignment_daily_review_consolidation_items"("run_id");
CREATE INDEX "assignment_daily_review_consolidation_items_workspace_id_section_idx" ON "assignment_daily_review_consolidation_items"("workspace_id", "section");
CREATE INDEX "assignment_daily_review_consolidation_items_status_idx" ON "assignment_daily_review_consolidation_items"("status");

CREATE INDEX "assignment_daily_review_consolidation_events_run_id_idx" ON "assignment_daily_review_consolidation_events"("run_id");
CREATE INDEX "assignment_daily_review_consolidation_events_created_at_idx" ON "assignment_daily_review_consolidation_events"("created_at");

ALTER TABLE "assignment_daily_review_consolidation_runs"
  ADD CONSTRAINT "assignment_daily_review_consolidation_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_daily_review_consolidation_items"
  ADD CONSTRAINT "assignment_daily_review_consolidation_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "assignment_daily_review_consolidation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "assignment_daily_review_consolidation_events"
  ADD CONSTRAINT "assignment_daily_review_consolidation_events_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "assignment_daily_review_consolidation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
