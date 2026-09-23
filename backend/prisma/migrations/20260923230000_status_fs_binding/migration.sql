-- Pending Response build (23 Sep 2026): bind a ticket-status registry row to
-- the FreshService status id it stands for, so "Pending Response" <-> FS 6 in
-- both directions (plans/PENDING_RESPONSE_STATUS_SYNC.md). Additive only.
ALTER TABLE "ticket_status_definitions" ADD COLUMN IF NOT EXISTS "freshservice_status_id" INTEGER;
ALTER TABLE "ticket_status_definitions" ADD COLUMN IF NOT EXISTS "fs_detected_at" TIMESTAMPTZ(6);
