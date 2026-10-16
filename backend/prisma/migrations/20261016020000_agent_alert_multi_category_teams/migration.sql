-- My alerts (Oct 2026): several categories per alert + a Teams delivery option.
ALTER TABLE "agent_alert_subscriptions" ADD COLUMN IF NOT EXISTS "category_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "agent_alert_subscriptions" ADD COLUMN IF NOT EXISTS "channel_teams" BOOLEAN NOT NULL DEFAULT false;

-- Carry the legacy single category into the new list (the old column stays, unwritten).
UPDATE "agent_alert_subscriptions" SET "category_ids" = ARRAY["category_id"] WHERE "category_id" IS NOT NULL AND cardinality("category_ids") = 0;
