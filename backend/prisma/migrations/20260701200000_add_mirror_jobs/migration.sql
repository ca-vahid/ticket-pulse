-- CreateTable
CREATE TABLE "mirror_jobs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "thread_entry_id" INTEGER,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mirror_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mirror_jobs_status_next_attempt_at_idx" ON "mirror_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "mirror_jobs_ticket_id_id_idx" ON "mirror_jobs"("ticket_id", "id");

-- CreateIndex
CREATE INDEX "mirror_jobs_workspace_id_status_idx" ON "mirror_jobs"("workspace_id", "status");

-- AddForeignKey
ALTER TABLE "mirror_jobs" ADD CONSTRAINT "mirror_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mirror_jobs" ADD CONSTRAINT "mirror_jobs_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

