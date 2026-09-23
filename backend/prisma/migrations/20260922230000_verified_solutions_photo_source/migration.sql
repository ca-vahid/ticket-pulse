-- QA 09-22: verified solutions (#6) + in-app profile photos (#7). Additive.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "solution_verified_at" TIMESTAMP(3);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "solution_verified_by" VARCHAR(255);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "solution_note" TEXT;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "photo_source" VARCHAR(20);
-- The partial index for the "Verified solutions in this category" lookup is
-- created OUT OF BAND with CREATE INDEX CONCURRENTLY (tickets is a live table;
-- CONCURRENTLY cannot run inside the transaction a migration runs in):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tickets_ws_solution_category"
--     ON "tickets" ("workspace_id", "internal_category_id", "solution_verified_at" DESC)
--     WHERE "solution_verified_at" IS NOT NULL;
