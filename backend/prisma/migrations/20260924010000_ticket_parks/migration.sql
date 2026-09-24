-- Parked tickets (23/24 Sep 2026, plans/PARKED_BUILD_PLAN.md). A park is a
-- marker, not a status: the ticket stays Pending (FreshService sees 3) and
-- carries why it waits and until when. History kept; one active per ticket.
CREATE TABLE IF NOT EXISTS "ticket_parks" (
  "id" SERIAL PRIMARY KEY,
  "ticket_id" INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "workspace_id" INTEGER NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "until" TIMESTAMPTZ(6) NOT NULL,
  "reason" TEXT NOT NULL,
  "waiting_on" JSONB,
  "source" VARCHAR(20) NOT NULL DEFAULT 'agent',
  "parked_by" VARCHAR(255),
  "parked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "status_before" VARCHAR(50),
  "due_soon_notified_at" TIMESTAMPTZ(6),
  "ended_at" TIMESTAMPTZ(6),
  "end_reason" VARCHAR(30),
  "ended_by" VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS "idx_ticket_parks_ticket" ON "ticket_parks" ("ticket_id", "ended_at");
CREATE INDEX IF NOT EXISTS "idx_ticket_parks_due" ON "ticket_parks" ("until") WHERE "ended_at" IS NULL;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "parked_until" TIMESTAMPTZ(6);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "park_kind" VARCHAR(20);
-- The partial index on tickets (workspace_id, parked_until) WHERE parked_until
-- IS NOT NULL is created CONCURRENTLY out of band on prod (live table).
