-- Signature line spacing (QA 09-08).
-- Existing signatures default to 'tight': they are bare <p> lines today, so a
-- mail client's default paragraph margin is what made them render loose. Tight
-- is what Outlook/FreshService produce and what the reporter expects.
ALTER TABLE "user_email_signatures"
  ADD COLUMN IF NOT EXISTS "spacing" VARCHAR(10) NOT NULL DEFAULT 'tight';
