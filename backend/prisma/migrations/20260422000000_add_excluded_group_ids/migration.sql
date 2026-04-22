-- Add excluded_group_ids array to AssignmentConfig.
--
-- FreshService group IDs that are excluded from auto-assignment. When a
-- ticket's group_id is in this list, the LLM still runs and produces a
-- recommendation, but `decision` is forced to `pending_review` for manual
-- approval — even when `auto_assign=true`. Empty array (the default) means
-- no exclusions, preserving existing behavior.

ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "excluded_group_ids" INTEGER[] NOT NULL DEFAULT '{}';
