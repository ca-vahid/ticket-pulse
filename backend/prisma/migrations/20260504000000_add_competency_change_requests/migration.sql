CREATE TABLE "competency_change_requests" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "competency_category_id" INTEGER NOT NULL,
    "request_type" VARCHAR(30) NOT NULL,
    "current_level" VARCHAR(20),
    "requested_level" VARCHAR(20),
    "note" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "requested_by_email" VARCHAR(255) NOT NULL,
    "reviewed_by_email" VARCHAR(255),
    "reviewed_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_change_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "competency_change_requests_workspace_id_status_idx" ON "competency_change_requests"("workspace_id", "status");
CREATE INDEX "competency_change_requests_technician_id_status_idx" ON "competency_change_requests"("technician_id", "status");
CREATE INDEX "competency_change_requests_competency_category_id_idx" ON "competency_change_requests"("competency_category_id");
CREATE INDEX "competency_change_requests_requested_by_email_idx" ON "competency_change_requests"("requested_by_email");

ALTER TABLE "competency_change_requests"
  ADD CONSTRAINT "competency_change_requests_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "competency_change_requests"
  ADD CONSTRAINT "competency_change_requests_technician_id_fkey"
  FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "competency_change_requests"
  ADD CONSTRAINT "competency_change_requests_competency_category_id_fkey"
  FOREIGN KEY ("competency_category_id") REFERENCES "competency_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
