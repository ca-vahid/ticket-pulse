-- CreateTable
CREATE TABLE "ticket_attachments" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "thread_entry_id" INTEGER,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "blob_name" VARCHAR(500) NOT NULL,
    "source" VARCHAR(20) NOT NULL DEFAULT 'upload',
    "uploaded_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_attachments_blob_name_key" ON "ticket_attachments"("blob_name");

-- CreateIndex
CREATE INDEX "ticket_attachments_ticket_id_idx" ON "ticket_attachments"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_attachments_workspace_id_idx" ON "ticket_attachments"("workspace_id");

-- CreateIndex
CREATE INDEX "ticket_attachments_thread_entry_id_idx" ON "ticket_attachments"("thread_entry_id");

-- AddForeignKey
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

