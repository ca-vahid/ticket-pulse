-- Scheduled-ticket attachments (gap plan 2, Phase 2): files staged against a
-- schedule; adopted as real ticket attachments at activation.

CREATE TABLE IF NOT EXISTS "scheduled_ticket_attachments" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "scheduled_ticket_id" INTEGER NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(255),
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "blob_name" VARCHAR(500) NOT NULL,
    "uploaded_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_ticket_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scheduled_ticket_attachments_scheduled_ticket_id_idx"
    ON "scheduled_ticket_attachments"("scheduled_ticket_id");

DO $$ BEGIN
    ALTER TABLE "scheduled_ticket_attachments"
        ADD CONSTRAINT "scheduled_ticket_attachments_scheduled_ticket_id_fkey"
        FOREIGN KEY ("scheduled_ticket_id") REFERENCES "scheduled_tickets"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
