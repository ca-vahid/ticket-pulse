-- MEGA 09-01 Phase TU-3e: dedicated reconcile-sweep cursor on tickets.
-- The FS existence/spam reconcile used `updated_at ASC` as its queue order and
-- bumped `updated_at` on every verified ticket (200 per sweep, every 5 min),
-- which made updated_at meaningless (8,861 tickets/day "updated" vs 325 with
-- real activity). Idempotent: safe to re-run on dev and prod.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "last_reconciled_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "idx_tickets_ws_origin_last_reconciled"
  ON "tickets" ("workspace_id", "origin", "last_reconciled_at");
