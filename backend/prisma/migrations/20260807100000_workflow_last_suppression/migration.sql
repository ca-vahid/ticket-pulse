-- Last routing-suppression decision per notification workflow (QA 08-06 #6):
-- the engine records why a workflow was skipped (routing_rule_not_matched,
-- missing_routing_rule, ...) so the editor can show "last skipped" instead of
-- silent nothing. Idempotent.
ALTER TABLE "notification_workflows" ADD COLUMN IF NOT EXISTS "last_suppressed_at" TIMESTAMP(3);
ALTER TABLE "notification_workflows" ADD COLUMN IF NOT EXISTS "last_suppressed_reason" VARCHAR(80);
