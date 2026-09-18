-- QA 09-17 #1: per-workspace meaning of "calendar-aware SLAs".
-- 'business_hours' keeps the existing behaviour (only the hours inside the
-- business-hours window burn SLA time); 'business_days' runs a 24-hour clock
-- that skips non-working days whole (Friday 2 pm + 24 h = Monday 2 pm).
ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "sla_calendar_style" VARCHAR(20) NOT NULL DEFAULT 'business_hours';
