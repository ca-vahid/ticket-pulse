-- FreshService approvals become visible to Ticket Pulse (17 Sep 2026).
-- Copied from the FreshService ticket payload on every sync: approval_status (0 requested,
-- 1 approved, 2 rejected, 3 cancelled, 4 not requested) and its label. Additive, nullable.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "fs_approval_status" INTEGER;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "fs_approval_status_name" VARCHAR(40);
