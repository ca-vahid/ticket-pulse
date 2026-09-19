-- ContinuIT D2 (19 Sep 2026): a webhook subscription may be limited to tickets
-- whose externalRef starts with a prefix ("only my tickets"). Additive.
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "external_ref_prefix" VARCHAR(100);
