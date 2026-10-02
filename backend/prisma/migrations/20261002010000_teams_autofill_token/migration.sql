-- QA 10-01 #3: Autofill from the Teams bot. One row per message an agent sends
-- the bot (extraction + pictures + the card it lives on). The token hash opens
-- /tickets/new?autofill=<token> for the same person for 30 minutes. Additive
-- and idempotent; a new, empty table (no lock on a live table).
CREATE TABLE IF NOT EXISTS "teams_autofill_drafts" (
    "id" SERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "technician_id" INTEGER,
    "intake_run_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'reading',
    "data" JSONB,
    "images" JSONB,
    "source_text" TEXT,
    "notes" JSONB,
    "service_url" VARCHAR(255),
    "conversation_id" VARCHAR(255),
    "activity_id" VARCHAR(255),
    "ticket_id" INTEGER,
    "error" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "teams_autofill_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "teams_autofill_drafts_token_hash_key" ON "teams_autofill_drafts"("token_hash");
CREATE INDEX IF NOT EXISTS "teams_autofill_drafts_email_created_at_idx" ON "teams_autofill_drafts"("email", "created_at");
CREATE INDEX IF NOT EXISTS "teams_autofill_drafts_expires_at_idx" ON "teams_autofill_drafts"("expires_at");
