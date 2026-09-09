-- The AI's "needs no follow-up" label, decoupled from routing (QA 09-05, option 3).
-- Defaults to false so every historical run is unchanged; the auto-close path
-- continues to key off an empty recommendations array, never this column.
ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "non_actionable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "non_actionable_reason" TEXT;
