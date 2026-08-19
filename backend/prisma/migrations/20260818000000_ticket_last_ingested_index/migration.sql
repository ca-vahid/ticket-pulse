-- Phase SH (sync-health honesty, 2026-08-18 alert-storm fix): sync health now
-- reads per-workspace MAX(tickets.last_ingested_at) as its data-freshness
-- signal on every poll — this composite index turns that into an O(1)
-- backward index probe per workspace instead of a table scan every 5 minutes.
-- Idempotent; safe to re-apply.
CREATE INDEX IF NOT EXISTS "tickets_workspace_id_last_ingested_at_idx"
    ON "tickets"("workspace_id", "last_ingested_at" DESC);
