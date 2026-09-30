-- Auto-help: approve by day, auto by night (30 Sep 2026). Additive only.
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "auto_after_hours" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "after_hours_summary_to" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "after_hours_summary_sent_for" VARCHAR(10);
