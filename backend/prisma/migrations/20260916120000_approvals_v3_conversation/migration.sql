-- Approvals v3 (16 Sep 2026): the conversation loop. All additive.
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "condition_note" TEXT;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "condition_note_html" TEXT;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "signature_html" TEXT;

CREATE TABLE IF NOT EXISTS "approval_messages" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "approval_id" INTEGER,
  "request_group_id" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "audience" VARCHAR(16) NOT NULL DEFAULT 'requester',
  "author_email" VARCHAR(255) NOT NULL,
  "author_name" VARCHAR(255),
  "author_role" VARCHAR(16) NOT NULL DEFAULT 'approver',
  "body_text" TEXT,
  "body_html" TEXT,
  "via" VARCHAR(10) NOT NULL DEFAULT 'app',
  "to_emails" TEXT[] NOT NULL DEFAULT '{}',
  "cc_emails" TEXT[] NOT NULL DEFAULT '{}',
  "email_message_id" VARCHAR(998),
  "in_reply_to_id" INTEGER,
  "thread_entry_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "approval_messages_request_group_id_idx" ON "approval_messages"("request_group_id");
CREATE INDEX IF NOT EXISTS "approval_messages_ticket_id_idx" ON "approval_messages"("ticket_id");

CREATE TABLE IF NOT EXISTS "approval_reply_tokens" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "message_id" INTEGER NOT NULL,
  "request_group_id" VARCHAR(64) NOT NULL,
  "recipient_email" VARCHAR(255) NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "plus_key" VARCHAR(24) NOT NULL,
  "expires_at" TIMESTAMP(3),
  "used_at" TIMESTAMP(3),
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "approval_reply_tokens_token_hash_key" ON "approval_reply_tokens"("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "approval_reply_tokens_plus_key_key" ON "approval_reply_tokens"("plus_key");
CREATE INDEX IF NOT EXISTS "approval_reply_tokens_message_id_idx" ON "approval_reply_tokens"("message_id");
