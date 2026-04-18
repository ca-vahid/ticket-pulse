-- Track when we last queried FreshService for a ticket's CSAT response.
-- Lets the scheduled CSAT sweep walk through the backlog (check never-
-- checked tickets first, re-check others at most once per 24h) instead of
-- re-asking FS about the same 30 freshly-synced tickets every cycle.
ALTER TABLE "tickets" ADD COLUMN "csat_checked_at" TIMESTAMP(3);

-- Index to make "ORDER BY csat_checked_at ASC NULLS FIRST" fast.
CREATE INDEX "tickets_csat_checked_at_idx" ON "tickets"("csat_checked_at");
