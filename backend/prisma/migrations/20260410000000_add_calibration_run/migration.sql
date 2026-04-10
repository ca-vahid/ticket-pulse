-- CreateTable
CREATE TABLE "calibration_runs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'running',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "triggered_by" VARCHAR(255),
    "total_runs" INTEGER,
    "outcome_1_count" INTEGER,
    "outcome_2_count" INTEGER,
    "outcome_3_count" INTEGER,
    "unresolved_count" INTEGER,
    "classified_data" JSONB,
    "prompt_findings" JSONB,
    "prompt_draft_id" INTEGER,
    "prompt_analysis_tokens" INTEGER,
    "flagged_tech_ids" JSONB,
    "competency_run_ids" JSONB,
    "techs_processed" INTEGER,
    "techs_total" INTEGER,
    "total_duration_ms" INTEGER,
    "total_tokens_used" INTEGER,
    "error_message" TEXT,
    "full_transcript" TEXT,
    "llm_model" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calibration_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calibration_runs_workspace_id_idx" ON "calibration_runs"("workspace_id");
CREATE INDEX "calibration_runs_status_idx" ON "calibration_runs"("status");
CREATE INDEX "calibration_runs_created_at_idx" ON "calibration_runs"("created_at");

-- AddForeignKey
ALTER TABLE "calibration_runs" ADD CONSTRAINT "calibration_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
