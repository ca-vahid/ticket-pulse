-- QA 10-01 #4: an admin can disconnect an agent from the Teams bot. The mark
-- stops every send (no silent re-install) until someone connects them again.
ALTER TABLE "teams_conversations" ADD COLUMN IF NOT EXISTS "disconnected_at" TIMESTAMP(3);
ALTER TABLE "teams_conversations" ADD COLUMN IF NOT EXISTS "disconnected_by" VARCHAR(255);
