-- Phase DB (QA 08-21 #6): per-workspace toggle for the duplicate-burst guard.
-- Default TRUE preserves today's behavior everywhere; ops flips it OFF for
-- ws5 (Project Accounting) post-deploy, whose legitimate Power App requests
-- share subjects and differ only in the body.
-- Idempotent: safe to re-run against a database that already has the column.
ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "duplicate_burst_enabled" BOOLEAN NOT NULL DEFAULT true;
