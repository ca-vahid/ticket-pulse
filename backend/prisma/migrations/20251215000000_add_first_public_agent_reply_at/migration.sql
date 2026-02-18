-- Add first public agent reply timestamp field
ALTER TABLE "tickets" ADD COLUMN "first_public_agent_reply_at" TIMESTAMP;

-- Add comment for clarity
COMMENT ON COLUMN "tickets"."first_public_agent_reply_at" IS 'Timestamp of the first public (non-private) agent reply to the requester (from FreshService activities API)';

-- Index to support reporting/analytics queries
CREATE INDEX IF NOT EXISTS "tickets_first_public_agent_reply_at_idx" ON "tickets" ("first_public_agent_reply_at");


