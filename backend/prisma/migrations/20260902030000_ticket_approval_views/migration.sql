-- Phase AP (09-02): public approval page view telemetry.
-- Counts how often (and when) an approver opened their magic-link page so the
-- ticket's approval timeline can show "seen" vs "never opened".
-- Idempotent: safe to re-run on dev and prod.
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "view_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "last_viewed_at" TIMESTAMP(3);
