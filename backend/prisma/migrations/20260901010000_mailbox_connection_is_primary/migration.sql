-- MailboxConnection.isPrimary (Mega 08-31 Phase MB-1g): preferred outbound
-- sender when a workspace connects more than one send-capable mailbox. The
-- centralized picker (services/mailboxPicker.js) orders is_primary DESC, id ASC.
-- Partial unique index = at most ONE primary per workspace.
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying the code.
ALTER TABLE "mailbox_connections"
    ADD COLUMN IF NOT EXISTS "is_primary" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_connections_one_primary_per_workspace_idx"
    ON "mailbox_connections" ("workspace_id")
    WHERE "is_primary";
