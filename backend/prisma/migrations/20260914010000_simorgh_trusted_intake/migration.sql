-- Simorgh direct integration (09-14). All additive.
--
-- trusted_intake: a credential whose tickets Ticket Pulse must never re-classify,
-- re-type, re-prioritise or noise-close. The ticket is stamped triage_mode='trusted'
-- at creation so every later pipeline trigger honours it without consulting the key.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "trusted_intake" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "ip_allowlist"   TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "default_source" INTEGER;
ALTER TABLE "api_keys"      ADD COLUMN IF NOT EXISTS "trusted_intake" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "triage_mode"       VARCHAR(20);
-- Resolution details (C4/D3): why a ticket was resolved, in a fixed vocabulary,
-- plus a free note and who did it. Required only for Security-category tickets.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolution_reason" VARCHAR(40);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolution_note"   TEXT;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "resolved_by_kind"  VARCHAR(20);

-- An unattended mailbox (an automation's requester record): no requester-facing
-- email is ever sent to it.
ALTER TABLE "requesters" ADD COLUMN IF NOT EXISTS "unattended" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "tickets_triage_mode_idx" ON "tickets" ("workspace_id") WHERE "triage_mode" IS NOT NULL;
