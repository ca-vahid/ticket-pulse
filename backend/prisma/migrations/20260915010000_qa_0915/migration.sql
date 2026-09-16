-- QA 09-15 package. Additive.
--
-- #1: per-workspace switch — show AI assignment suggestions to basic-access
-- (technician-only) and read-only members. Default true = today's behaviour.
ALTER TABLE "assignment_configs" ADD COLUMN IF NOT EXISTS "ai_suggestions_for_basic" BOOLEAN NOT NULL DEFAULT true;
