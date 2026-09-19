-- Simorgh SOC relations, Phase B (plans/SIMORGH_SOC_RELATIONS_PLAN.md). Additive.

-- B6: an API client that may only merge / split / re-parent / link tickets it created.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "structure_own_tickets_only" BOOLEAN NOT NULL DEFAULT false;

-- B8: set when every child of a parent has reached a terminal status and the
-- parent has not; cleared when a child reopens or the parent closes.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "ready_to_close_at" TIMESTAMP(3);

-- B4: the caller's own key for a task (create-or-return), unique per ticket.
ALTER TABLE "ticket_tasks" ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR(200);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ticket_tasks_ticket_external_ref"
  ON "ticket_tasks" ("ticket_id", "external_ref") WHERE "external_ref" IS NOT NULL;
