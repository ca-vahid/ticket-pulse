-- Analytics Reports (feedback 07-14 #2): saved report snapshots — a
-- deterministic dataset plus a clearly-labeled AI narrative, generated on
-- demand for weekly-meeting discussion.
CREATE TABLE "analytics_reports" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "scope" JSONB NOT NULL,
    "range_start" TIMESTAMP(3) NOT NULL,
    "range_end" TIMESTAMP(3) NOT NULL,
    "dataset" JSONB NOT NULL,
    "narrative" JSONB,
    "llm_model" VARCHAR(100),
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_reports_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "analytics_reports"
    ADD CONSTRAINT "analytics_reports_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "analytics_reports_workspace_id_created_at_idx"
    ON "analytics_reports"("workspace_id", "created_at");
