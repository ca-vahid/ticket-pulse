-- Add rebound_from JSON field to track auto-requeue context.
-- When a ticket is unassigned (returned to queue) after being assigned,
-- the sync service creates a new pipeline run with trigger_source='rebound'
-- and stores the previous assignee + unassignment details here so the
-- coordinator (and the LLM) have context about the bounce.

ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "rebound_from" JSONB;
