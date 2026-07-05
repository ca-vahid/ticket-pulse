-- CreateTable
CREATE TABLE "ticket_approvals" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "approver_email" VARCHAR(255) NOT NULL,
    "approver_name" VARCHAR(255),
    "requested_by" VARCHAR(255) NOT NULL,
    "request_note" TEXT,
    "decision_note" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_via" VARCHAR(20),
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_approvals_token_hash_key" ON "ticket_approvals"("token_hash");

-- CreateIndex
CREATE INDEX "ticket_approvals_ticket_id_idx" ON "ticket_approvals"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_approvals_workspace_id_status_idx" ON "ticket_approvals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "ticket_approvals_approver_email_idx" ON "ticket_approvals"("approver_email");

-- AddForeignKey
ALTER TABLE "ticket_approvals" ADD CONSTRAINT "ticket_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_approvals" ADD CONSTRAINT "ticket_approvals_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

