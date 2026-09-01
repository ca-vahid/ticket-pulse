-- MailboxConnection Graph change-notification state (Mega 08-31 Phase MB-2a).
-- One Graph subscription per ingest-capable mailbox (created on
-- /users/{mb}/mailFolders('inbox')/messages, ~6-day TTL renewed by the
-- subscription manager); clientState is the per-connection shared secret Graph
-- echoes on every notification; delta_link is the poller's catch-up cursor;
-- notification_status = active | renewing | error | disabled.
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying the code.
ALTER TABLE "mailbox_connections"
    ADD COLUMN IF NOT EXISTS "subscription_id" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "subscription_expires_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "client_state" VARCHAR(100),
    ADD COLUMN IF NOT EXISTS "delta_link" TEXT,
    ADD COLUMN IF NOT EXISTS "notification_status" VARCHAR(30),
    ADD COLUMN IF NOT EXISTS "last_notification_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "mailbox_connections_subscription_id_idx"
    ON "mailbox_connections" ("subscription_id");
