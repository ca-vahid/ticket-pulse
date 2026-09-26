-- Out of band, NOT a Prisma migration: tickets is a live table, and a plain
-- CREATE INDEX there starves the connection pool (Sep 2026). Run by hand with
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/scripts/sql/auto-help-parked-until-index.sql
-- CONCURRENTLY cannot run inside a transaction: do not wrap it.
--
-- BEFORE running: check whether a partial index on parked_until already
-- exists (the parked-tickets release created one out of band, possibly under
-- another name) — if so, do nothing:
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'tickets' AND indexdef ILIKE '%parked_until%';
-- IF THE BUILD FAILS (lock timeout, cancelled, connection lost) Postgres
-- leaves an INVALID index behind that IF NOT EXISTS will then skip. Find it
--   SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--   WHERE NOT i.indisvalid AND c.relname = 'idx_tickets_parked_until';
-- drop it without locking writes, then re-run this file:
--   DROP INDEX CONCURRENTLY IF EXISTS "idx_tickets_parked_until";
--
-- The park sweep's safety net and Auto-help's stale-marker recovery read
-- "tickets marked parked" every minute. The parked tickets release
-- (20260924010000_ticket_parks) documented this index as created out of band;
-- this makes it idempotent and checkable. Skip if it already exists.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_parked_until"
  ON "tickets" ("workspace_id", "parked_until")
  WHERE "parked_until" IS NOT NULL;
