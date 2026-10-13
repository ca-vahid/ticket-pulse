-- IT intake plan (12 Oct 2026): a mailbox is either a side mailbox ('standard') or the team's front door ('helpdesk').
-- Additive. Every existing mailbox keeps today's behaviour.
ALTER TABLE "mailbox_connections" ADD COLUMN IF NOT EXISTS "intake_profile" VARCHAR(20) NOT NULL DEFAULT 'standard';
