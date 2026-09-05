-- QA 09-04: a noise rule may only auto-close mail that a MACHINE sent.
-- (A) rules that are meant to swallow human forwards opt back in explicitly;
-- (B) a rule can require the sender's address to match as well as the subject;
-- (F) a match the sender guard held back is recorded on the ticket instead of vanishing.
ALTER TABLE "noise_rules" ADD COLUMN IF NOT EXISTS "sender_pattern" TEXT;
ALTER TABLE "noise_rules" ADD COLUMN IF NOT EXISTS "auto_close_from_people" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "noise_rule_suppressed" VARCHAR(255);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "noise_suppress_reason" VARCHAR(120);

-- The audit panel lists the held-back matches newest first.
CREATE INDEX IF NOT EXISTS "tickets_noise_rule_suppressed_idx"
  ON "tickets" ("workspace_id", "noise_rule_suppressed", "created_at" DESC)
  WHERE "noise_rule_suppressed" IS NOT NULL;
