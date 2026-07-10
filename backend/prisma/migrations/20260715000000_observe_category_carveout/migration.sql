-- Observation carve-out: observed groups can still receive AI categories
-- (ticket + FS) while assignment/noise/priority/type stay mocked. Additive.
ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "observe_category_writeback_enabled" BOOLEAN NOT NULL DEFAULT false;
