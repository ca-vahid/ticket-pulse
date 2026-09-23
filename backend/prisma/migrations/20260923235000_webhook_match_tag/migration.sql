-- ContinuIT search request (23 Sep 2026): a webhook subscription limited to
-- "my tickets" also receives tickets carrying this tag — the tickets
-- ContinuIT links to rather than creates. Additive.
ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "match_tag" VARCHAR(100);
