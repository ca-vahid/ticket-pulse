-- Delay-node durable resume: a run parked on a `delay` node persists its state
-- and continues from resume_node_id when resume_at passes (status='waiting').
ALTER TABLE "notification_workflow_runs" ADD COLUMN IF NOT EXISTS "resume_at" TIMESTAMP(3);
ALTER TABLE "notification_workflow_runs" ADD COLUMN IF NOT EXISTS "resume_node_id" VARCHAR(80);
ALTER TABLE "notification_workflow_runs" ADD COLUMN IF NOT EXISTS "resume_state" JSONB;

CREATE INDEX IF NOT EXISTS "notification_workflow_runs_status_resume_at_idx"
  ON "notification_workflow_runs"("status", "resume_at");
