-- Assetron laptop reservations from the approval flow (24 Sep 2026). Additive.
ALTER TABLE "approval_categories" ADD COLUMN IF NOT EXISTS "gates_hardware" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "assetron_reservations" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "request_group_id" VARCHAR(64) NOT NULL,
  "approval_category_id" INTEGER,
  "reservation_id" VARCHAR(80) NOT NULL,
  "asset_id" VARCHAR(80) NOT NULL,
  "asset" JSONB,
  "recipient_email" VARCHAR(255) NOT NULL,
  "recipient_name" VARCHAR(255),
  "recipient_entra_id" VARCHAR(80),
  "requested_by_email" VARCHAR(255),
  "state" VARCHAR(20) NOT NULL DEFAULT 'reserved',
  "pending_outcome" VARCHAR(20),
  "outcome" VARCHAR(20),
  "outcome_why" VARCHAR(40),
  "decided_by_email" VARCHAR(255),
  "decided_by_name" VARCHAR(255),
  "decided_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "assetron_reservations_request_group_id_key" ON "assetron_reservations"("request_group_id");
CREATE INDEX IF NOT EXISTS "assetron_reservations_workspace_id_state_idx" ON "assetron_reservations"("workspace_id", "state");
CREATE INDEX IF NOT EXISTS "assetron_reservations_ticket_id_idx" ON "assetron_reservations"("ticket_id");

-- The one hardware approval category in IT today.
UPDATE "approval_categories" SET "gates_hardware" = true WHERE "workspace_id" = 1 AND "name" = 'New Computer Upgrade';
