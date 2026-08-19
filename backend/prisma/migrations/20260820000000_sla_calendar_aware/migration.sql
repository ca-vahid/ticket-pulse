-- Calendar-aware SLAs (Phase SLA, v3.5.04-preview — QA 08-17 #9:
-- "does the SLA timer stop over the weekends?").
--
-- workspaces.sla_calendar_aware: per-workspace opt-in. When true, SLA
-- due-date clocks for TP-born tickets count business minutes only (the
-- existing business_hours + holidays tables). Defaults FALSE everywhere —
-- rollout is an explicit per-workspace opt-in via Settings → Ticket Ops.
--
-- sla_policies.calendar_mode: per-policy override —
--   'inherit'   (default) follow the workspace flag
--   'calendar'  always count business minutes
--   'always_on' always wall-clock (24/7 escape hatch for Urgent clocks)
--
-- Hand-written idempotent migration (same pattern as
-- 20260819000000_workspace_email_identities): applied to environments with
-- `prisma db execute` + `prisma migrate resolve --applied`, safe to re-run.

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "sla_calendar_aware" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sla_policies"
  ADD COLUMN IF NOT EXISTS "calendar_mode" VARCHAR(20) NOT NULL DEFAULT 'inherit';
