CREATE TABLE IF NOT EXISTS "ticket_reclassification_runs" (
    "id" SERIAL PRIMARY KEY,
    "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "mode" VARCHAR(20) NOT NULL,
    "actor_email" VARCHAR(255),
    "request" JSONB NOT NULL,
    "summary" JSONB,
    "results" JSONB,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "error_message" TEXT,
    "rolled_back_at" TIMESTAMP(3),
    "rolled_back_by" VARCHAR(255),
    "rollback_result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ticket_reclassification_runs_workspace_id_created_at_idx" ON "ticket_reclassification_runs"("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "ticket_reclassification_runs_workspace_id_status_idx" ON "ticket_reclassification_runs"("workspace_id", "status");
