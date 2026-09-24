-- QA 09-23 #8: "stop other workflows for this ticket change". When a
-- workflow with this flag runs for a ticket, lower-or-equal priority workflows
-- for the same ticket within the change window stay silent. Additive only.
ALTER TABLE "notification_workflows" ADD COLUMN IF NOT EXISTS "stop_further_workflows" BOOLEAN NOT NULL DEFAULT false;
