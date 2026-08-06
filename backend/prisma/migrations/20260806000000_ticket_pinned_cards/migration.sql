-- Pinned workflow cards (Custom Fields Activation Phase 1): the add_note
-- workflow action with placement pinned/both upserts ONE card per
-- (ticket, kind, workflow) — re-runs refresh the payload and clear the
-- dismissal instead of stacking duplicates. Payload carries the same
-- field_card shape stored on thread-entry raw_payload.
-- Idempotent; safe to re-apply.
CREATE TABLE IF NOT EXISTS "ticket_pinned_cards" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "payload" JSONB NOT NULL,
    "workflow_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_at" TIMESTAMP(3),
    "dismissed_by" VARCHAR(255),

    CONSTRAINT "ticket_pinned_cards_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "ticket_pinned_cards"
        ADD CONSTRAINT "ticket_pinned_cards_ticket_id_fkey"
        FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_pinned_cards_ticket_id_kind_workflow_id_key"
    ON "ticket_pinned_cards"("ticket_id", "kind", "workflow_id");
CREATE INDEX IF NOT EXISTS "ticket_pinned_cards_ticket_id_dismissed_at_idx"
    ON "ticket_pinned_cards"("ticket_id", "dismissed_at");
