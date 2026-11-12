-- Composer drafts on the server (12 Nov 2026). Additive only: one new table,
-- nothing changed on existing ones. One row per person per ticket: their
-- unsent reply or note, so it follows them to another computer. Removed when
-- they send or clear it.
CREATE TABLE IF NOT EXISTS "ticket_drafts" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "owner_email" VARCHAR(255) NOT NULL,
  "mode" VARCHAR(10) NOT NULL,
  "body_html" TEXT NOT NULL,
  "cc" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_drafts_ticket_id_owner_email_key" ON "ticket_drafts" ("ticket_id", "owner_email");
CREATE INDEX IF NOT EXISTS "ticket_drafts_workspace_id_owner_email_idx" ON "ticket_drafts" ("workspace_id", "owner_email");
CREATE INDEX IF NOT EXISTS "ticket_drafts_updated_at_idx" ON "ticket_drafts" ("updated_at");
