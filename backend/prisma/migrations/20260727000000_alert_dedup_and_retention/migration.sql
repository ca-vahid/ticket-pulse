-- Agent-alert dedup window + delivery retry bookkeeping.
--
-- Previously (subscription_id, ticket_id, trigger) was a FULL unique index, so
-- once ANY event existed for that tuple — even after it was sent — the same
-- trigger could never fire again on that ticket. A Medium→High→Urgent
-- escalation only ever alerted once. Make the uniqueness apply only to PENDING
-- (unsent) events: bursts still coalesce into one alert, but a later escalation
-- on the same ticket can alert again once the prior one was delivered.
DROP INDEX IF EXISTS "agent_alert_events_subscription_id_ticket_id_trigger_key";
CREATE UNIQUE INDEX "agent_alert_events_pending_uniq"
  ON "agent_alert_events" ("subscription_id", "ticket_id", "trigger")
  WHERE "sent_at" IS NULL;

-- Retry accounting: a batch that failed every channel is NOT marked sent, so it
-- retries — capped by this counter to avoid spinning forever on a permanent
-- failure (e.g. unverified phone).
ALTER TABLE "agent_alert_events"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Retention sweep support: prune sent rows by age (they no longer gate dedup).
CREATE INDEX IF NOT EXISTS "agent_alert_events_sent_at_idx"
  ON "agent_alert_events" ("sent_at");

-- Bound the channel-health telemetry table (one row per outbound send) with a
-- created_at-leading index so the periodic age-based sweep is a range scan.
CREATE INDEX IF NOT EXISTS "notification_channel_health_events_created_at_idx"
  ON "notification_channel_health_events" ("created_at");
