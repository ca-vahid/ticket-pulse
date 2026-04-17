-- CreateTable: backfill_runs
CREATE TABLE "backfill_runs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "start_date" VARCHAR(10) NOT NULL,
    "end_date" VARCHAR(10) NOT NULL,
    "skip_existing" BOOLEAN NOT NULL DEFAULT true,
    "activity_concurrency" INTEGER NOT NULL DEFAULT 3,
    "triggered_by_email" VARCHAR(255),
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "progress_step" VARCHAR(255),
    "progress_phase" VARCHAR(50),
    "tickets_total" INTEGER,
    "tickets_processed" INTEGER,
    "tickets_fetched" INTEGER,
    "tickets_synced" INTEGER,
    "activities_analyzed" INTEGER,
    "skipped_count" INTEGER,
    "elapsed_ms" INTEGER,
    "error_message" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_by_email" VARCHAR(255),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backfill_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backfill_runs_workspace_id_started_at_idx" ON "backfill_runs"("workspace_id", "started_at");
CREATE INDEX "backfill_runs_status_idx" ON "backfill_runs"("status");

ALTER TABLE "backfill_runs" ADD CONSTRAINT "backfill_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
