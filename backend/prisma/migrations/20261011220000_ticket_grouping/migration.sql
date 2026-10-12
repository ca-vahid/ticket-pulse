-- Ticket grouping (plans/TICKET_GROUPING_PLAN.md, 11 Oct 2026). Additive only.
-- Senders: what kind of mail one sender + subject shape is ("repeats itself" or
-- "every mail is its own item"), decided once by the model and editable by an admin.
CREATE TABLE IF NOT EXISTS "ticket_grouping_senders" (
  "id"             SERIAL PRIMARY KEY,
  "workspace_id"   INTEGER NOT NULL,
  "sender"         VARCHAR(255) NOT NULL,
  "template"       VARCHAR(300) NOT NULL,
  "kind"           VARCHAR(20) NOT NULL,
  "enabled"        BOOLEAN NOT NULL DEFAULT TRUE,
  "decided_by"     VARCHAR(255) NOT NULL DEFAULT 'ai',
  "reason"         TEXT,
  "sample_subject" TEXT,
  "repeat_count"   INTEGER NOT NULL DEFAULT 0,
  "last_repeat_at" TIMESTAMPTZ(6),
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_ticket_grouping_senders" ON "ticket_grouping_senders" ("workspace_id", "sender", "template");

-- Events: every ticket the engine looked at, and what it did (applied), proposed
-- (suggested) or found nothing for (kind 'checked'). One row per ticket + target.
CREATE TABLE IF NOT EXISTS "ticket_grouping_events" (
  "id"               SERIAL PRIMARY KEY,
  "workspace_id"     INTEGER NOT NULL,
  "ticket_id"        INTEGER NOT NULL,
  "target_ticket_id" INTEGER,
  "kind"             VARCHAR(20) NOT NULL,
  "state"            VARCHAR(20) NOT NULL,
  "confidence"       VARCHAR(10),
  "retraction"       BOOLEAN NOT NULL DEFAULT FALSE,
  "reason"           TEXT,
  "details"          JSONB,
  "sender_id"        INTEGER,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "decided_at"       TIMESTAMPTZ(6),
  "decided_by"       VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS "idx_ticket_grouping_events_ws" ON "ticket_grouping_events" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_ticket_grouping_events_ticket" ON "ticket_grouping_events" ("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_ticket_grouping_events_target" ON "ticket_grouping_events" ("target_ticket_id");
