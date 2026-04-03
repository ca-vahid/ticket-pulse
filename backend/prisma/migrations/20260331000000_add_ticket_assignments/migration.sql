-- Scaffolding for future ticket assignment feature
-- Creates the ticket_assignments table to track assignment history

CREATE TABLE IF NOT EXISTS "ticket_assignments" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "assigned_to_id" INTEGER NOT NULL,
    "assigned_by_email" VARCHAR(255) NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ticket_assignments_ticket_id_idx" ON "ticket_assignments"("ticket_id");
CREATE INDEX IF NOT EXISTS "ticket_assignments_assigned_to_id_idx" ON "ticket_assignments"("assigned_to_id");
CREATE INDEX IF NOT EXISTS "ticket_assignments_workspace_id_created_at_idx" ON "ticket_assignments"("workspace_id", "created_at");

ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
