CREATE TABLE "assignment_daily_review_recommendations" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "run_id" INTEGER NOT NULL,
  "review_date" DATE NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "severity" VARCHAR(20) NOT NULL,
  "rationale" TEXT NOT NULL,
  "suggested_action" TEXT NOT NULL,
  "skills_affected" JSONB,
  "supporting_ticket_ids" JSONB,
  "supporting_freshservice_ticket_ids" JSONB,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "review_notes" TEXT,
  "reviewed_by" VARCHAR(255),
  "reviewed_at" TIMESTAMP(3),
  "applied_by" VARCHAR(255),
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_daily_review_recommendations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assignment_daily_review_recommendations_run_id_kind_ordinal_key"
ON "assignment_daily_review_recommendations"("run_id", "kind", "ordinal");

CREATE INDEX "assignment_daily_review_recommendations_workspace_id_status_idx"
ON "assignment_daily_review_recommendations"("workspace_id", "status");

CREATE INDEX "assignment_daily_review_recommendations_workspace_id_review_date_idx"
ON "assignment_daily_review_recommendations"("workspace_id", "review_date");

CREATE INDEX "assignment_daily_review_recommendations_workspace_id_kind_idx"
ON "assignment_daily_review_recommendations"("workspace_id", "kind");

ALTER TABLE "assignment_daily_review_recommendations"
ADD CONSTRAINT "assignment_daily_review_recommendations_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_daily_review_recommendations"
ADD CONSTRAINT "assignment_daily_review_recommendations_run_id_fkey"
FOREIGN KEY ("run_id") REFERENCES "assignment_daily_review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
