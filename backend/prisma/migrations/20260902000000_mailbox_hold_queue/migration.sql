-- MEGA 09-01 Phase RL (RL-4 / RL-5): mailbox hold queue + per-mailbox
-- new-ticket policy + RFC Message-ID on workflow deliveries.
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying the code.

-- RL-4: per-mailbox safety switch. new_ticket_policy:
--   create         → unmatched mail always becomes a ticket (pre-RL behaviour)
--   replies_only   → unmatched mail is never a ticket (held for review)
--   hold_unmatched → fresh mail creates; mail with reply evidence and no
--                    known reference is held (default)
-- agent_cc_intake: rule 2 of the ingest decision table (agent reply-all with
-- the mailbox in Cc creates a ticket for the external requester).
ALTER TABLE "mailbox_connections"
    ADD COLUMN IF NOT EXISTS "new_ticket_policy" VARCHAR(20) NOT NULL DEFAULT 'hold_unmatched',
    ADD COLUMN IF NOT EXISTS "agent_cc_intake" BOOLEAN NOT NULL DEFAULT true;

-- RL-5: the RFC Message-ID (with angle brackets) the ack/workflow mail left
-- with — Graph internetMessageId or the SendGrid lane's minted id — so ingest
-- rung 1b can match a reply to a SendGrid-lane ack (provider_message_id holds
-- SendGrid's x-message-id, which never appears in In-Reply-To).
ALTER TABLE "notification_deliveries"
    ADD COLUMN IF NOT EXISTS "message_id" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "notification_deliveries_ws_message_id_idx"
    ON "notification_deliveries" ("workspace_id", "message_id");

-- RL-4: held inbound mail awaiting a human decision (attach / create / discard).
CREATE TABLE IF NOT EXISTS "mailbox_held_messages" (
    "id"                   SERIAL PRIMARY KEY,
    "workspace_id"         INTEGER NOT NULL,
    "connection_id"        INTEGER NOT NULL,
    "internet_message_id"  VARCHAR(255) NOT NULL,
    "from_email"           VARCHAR(255),
    "from_name"            VARCHAR(255),
    "to_emails"            JSONB,
    "cc_emails"            JSONB,
    "subject"              TEXT,
    "snippet"              VARCHAR(500),
    "body_html"            TEXT,
    "email_payload"        JSONB,
    "received_at"          TIMESTAMPTZ(6),
    "reason"               VARCHAR(40) NOT NULL,
    "best_guess_ticket_id" INTEGER,
    "candidates"           JSONB,
    "decision"             JSONB,
    "status"               VARCHAR(20) NOT NULL DEFAULT 'held',
    "resolved_by"          VARCHAR(255),
    "resolved_at"          TIMESTAMPTZ(6),
    "resolved_ticket_id"   INTEGER,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mailbox_held_messages_connection_id_fkey"
        FOREIGN KEY ("connection_id") REFERENCES "mailbox_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mailbox_held_messages_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_held_messages_connection_id_internet_message_id_key"
    ON "mailbox_held_messages" ("connection_id", "internet_message_id");

CREATE INDEX IF NOT EXISTS "mailbox_held_messages_workspace_id_status_idx"
    ON "mailbox_held_messages" ("workspace_id", "status");
