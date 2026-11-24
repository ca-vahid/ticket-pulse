-- Attachment display names (4.4.08): automatic vendor names for Accounting
-- attachments, with Revert and Edit. file_name stays the original name (the
-- stored blob and the FreshService mirror keep it); display_name is what the
-- ticket page shows and what downloads are named.
-- Additive only: nullable columns with no default, so ADD COLUMN is a
-- metadata-only change (no table rewrite, brief ACCESS EXCLUSIVE lock).

ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "display_name" VARCHAR(255);
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "name_source" VARCHAR(16);
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "name_details" JSONB;
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "named_at" TIMESTAMP(3);
ALTER TABLE "ticket_attachments" ADD COLUMN IF NOT EXISTS "named_by" VARCHAR(255);
