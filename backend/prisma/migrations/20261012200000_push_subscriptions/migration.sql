-- Device notifications (web push, 12 Oct 2026): one row per browser or
-- installed app a person turned notifications on for. Additive only.
-- Apply to production BEFORE the merge.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" SERIAL PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL,
  "endpoint" VARCHAR(1000) NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "user_agent" VARCHAR(255),
  "fail_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_sent_at" TIMESTAMPTZ(6)
);
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key" ON "push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "idx_push_subscriptions_email" ON "push_subscriptions" ("email");
