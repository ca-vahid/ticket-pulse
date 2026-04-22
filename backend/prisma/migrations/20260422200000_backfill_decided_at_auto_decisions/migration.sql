-- Backfill decidedAt for pipeline-decided runs.
--
-- Before v1.9.79-preview the _executeRun path never set decidedAt — only
-- admin actions (/decide, /dismiss) did. That silently hid auto_assigned
-- and noise_dismissed runs from the Decided and Dismissed tabs (which
-- filter by sinceField='decidedAt'). This migration fixes existing rows
-- by setting decidedAt = updatedAt, which is the moment the pipeline
-- finalized the decision (close enough for the time-range filter).
--
-- Scope: completed runs with an auto-decided outcome AND a NULL decidedAt.
-- We deliberately DO NOT touch:
--   - pending_review runs (decidedAt really should stay NULL)
--   - rejected runs (those come from admin actions; they already have decidedAt)
--   - approved/modified (same — admin-set)

UPDATE "assignment_pipeline_runs"
SET "decided_at" = "updated_at"
WHERE "status" = 'completed'
  AND "decision" IN ('auto_assigned', 'noise_dismissed')
  AND "decided_at" IS NULL;
