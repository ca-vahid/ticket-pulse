-- Add decision_note column for admin feedback on assignment decisions
ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "decision_note" TEXT;
