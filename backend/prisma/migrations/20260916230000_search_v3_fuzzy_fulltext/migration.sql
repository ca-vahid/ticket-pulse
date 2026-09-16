-- Search v3 (16 Sep 2026): fuzzy people names + full-text search over ticket
-- text and conversation bodies. Additive; applied by hand after the merge.
-- pg_trgm must be on the server's azure.extensions allow-list (done 16 Sep).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "requesters_name_trgm_idx" ON "requesters" USING GIN (lower("name") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "requesters_email_trgm_idx" ON "requesters" USING GIN (lower("email") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "technicians_name_trgm_idx" ON "technicians" USING GIN (lower("name") gin_trgm_ops);

-- Ticket text (subject + description) and conversation bodies, English stemming.
CREATE INDEX IF NOT EXISTS "tickets_fts_idx" ON "tickets"
  USING GIN (to_tsvector('english', coalesce("subject", '') || ' ' || coalesce("description_text", '')));
CREATE INDEX IF NOT EXISTS "ticket_thread_entries_fts_idx" ON "ticket_thread_entries"
  USING GIN (to_tsvector('english', coalesce("body_text", '')));
