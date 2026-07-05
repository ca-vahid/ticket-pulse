-- AlterTable
ALTER TABLE "ticket_thread_entries" ADD COLUMN     "email_message_id" VARCHAR(998);

-- CreateTable
CREATE TABLE "mailbox_connections" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "address" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(255),
    "mode" VARCHAR(10) NOT NULL DEFAULT 'both',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "poll_interval_sec" INTEGER NOT NULL DEFAULT 60,
    "last_checked_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mailbox_connections_is_enabled_idx" ON "mailbox_connections"("is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "mailbox_connections_workspace_id_address_key" ON "mailbox_connections"("workspace_id", "address");

-- CreateIndex
CREATE INDEX "ticket_thread_entries_email_message_id_idx" ON "ticket_thread_entries"("email_message_id");

-- AddForeignKey
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

