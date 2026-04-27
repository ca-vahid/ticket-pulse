CREATE TABLE IF NOT EXISTS "assignment_corrections" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "pipeline_run_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "from_technician_id" INTEGER,
  "to_technician_id" INTEGER NOT NULL,
  "selection_source" VARCHAR(30) NOT NULL,
  "recommendation_rank" INTEGER,
  "reason" TEXT NOT NULL,
  "created_by_email" VARCHAR(255),
  "freshservice_sync_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "freshservice_sync_error" TEXT,
  "freshservice_synced_at" TIMESTAMP(3),
  "freshservice_payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assignment_corrections_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assignment_corrections_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "assignment_corrections_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "assignment_corrections_from_technician_id_fkey"
    FOREIGN KEY ("from_technician_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "assignment_corrections_to_technician_id_fkey"
    FOREIGN KEY ("to_technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "assignment_corrections_workspace_id_idx" ON "assignment_corrections"("workspace_id");
CREATE INDEX IF NOT EXISTS "assignment_corrections_pipeline_run_id_idx" ON "assignment_corrections"("pipeline_run_id");
CREATE INDEX IF NOT EXISTS "assignment_corrections_ticket_id_idx" ON "assignment_corrections"("ticket_id");
CREATE INDEX IF NOT EXISTS "assignment_corrections_to_technician_id_idx" ON "assignment_corrections"("to_technician_id");
CREATE INDEX IF NOT EXISTS "assignment_corrections_created_at_idx" ON "assignment_corrections"("created_at");
