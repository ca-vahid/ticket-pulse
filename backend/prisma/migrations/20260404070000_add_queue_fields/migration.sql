-- Add queue audit fields to assignment_pipeline_runs
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "queued_at" TIMESTAMP(3);
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "queued_reason" VARCHAR(255);
ALTER TABLE "assignment_pipeline_runs" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);

-- Make llm_model nullable (queued runs don't have a model yet)
ALTER TABLE "assignment_pipeline_runs" ALTER COLUMN "llm_model" DROP NOT NULL;

-- Make decision nullable (queued runs have no decision yet)
ALTER TABLE "assignment_pipeline_runs" ALTER COLUMN "decision" DROP NOT NULL;
ALTER TABLE "assignment_pipeline_runs" ALTER COLUMN "decision" DROP DEFAULT;
