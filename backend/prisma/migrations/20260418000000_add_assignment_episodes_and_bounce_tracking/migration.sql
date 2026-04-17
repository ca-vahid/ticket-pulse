-- AlterTable: add bounce/rejection tracking columns to tickets
ALTER TABLE "tickets" ADD COLUMN "rejection_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tickets" ADD COLUMN "group_id" BIGINT;

-- CreateTable: ticket_assignment_episodes
CREATE TABLE "ticket_assignment_episodes" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "start_method" VARCHAR(30) NOT NULL,
    "start_assigned_by_name" VARCHAR(255),
    "end_method" VARCHAR(20),
    "end_actor_name" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_assignment_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_assignment_episodes_ticket_id_idx" ON "ticket_assignment_episodes"("ticket_id");
CREATE INDEX "ticket_assignment_episodes_technician_id_idx" ON "ticket_assignment_episodes"("technician_id");
CREATE INDEX "ticket_assignment_episodes_workspace_id_idx" ON "ticket_assignment_episodes"("workspace_id");
CREATE INDEX "ticket_assignment_episodes_end_method_idx" ON "ticket_assignment_episodes"("end_method");
CREATE INDEX "ticket_assignment_episodes_started_at_idx" ON "ticket_assignment_episodes"("started_at");
CREATE UNIQUE INDEX "ticket_assignment_episodes_ticket_id_started_at_key" ON "ticket_assignment_episodes"("ticket_id", "started_at");

-- CreateIndex on ticket_activities for activityType
CREATE INDEX IF NOT EXISTS "ticket_activities_activityType_idx" ON "ticket_activities"("activityType");

-- AddForeignKey
ALTER TABLE "ticket_assignment_episodes" ADD CONSTRAINT "ticket_assignment_episodes_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_assignment_episodes" ADD CONSTRAINT "ticket_assignment_episodes_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_assignment_episodes" ADD CONSTRAINT "ticket_assignment_episodes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
