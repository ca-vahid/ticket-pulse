-- Approvals v2 (QA 09-15 #8): tiers, amounts + auto-escalation, forward-to-anyone.
-- All additive. Table names verified against information_schema (approval_categories,
-- ticket_approvals, workspaces).
ALTER TABLE "approval_categories" ADD COLUMN IF NOT EXISTS "tiers" JSONB;
ALTER TABLE "approval_categories" ADD COLUMN IF NOT EXISTS "has_amount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "approval_categories" ADD COLUMN IF NOT EXISTS "amount_currency" VARCHAR(8) NOT NULL DEFAULT 'CAD';

ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "tier" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "amount" DECIMAL(14,2);
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "amount_currency" VARCHAR(8);
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "is_final" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "escalation_log" JSONB;

-- Per-workspace assignment fast-sync interval (minutes; 1 = every minute, the old fixed cadence).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "fast_sync_interval_minutes" INTEGER NOT NULL DEFAULT 1;
