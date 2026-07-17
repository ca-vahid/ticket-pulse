-- Custom agent alerts (per-agent subscriptions + storm-coalescing buffer).

-- Quiet-hours fields on the existing per-agent notification preference.
ALTER TABLE "technician_notification_preferences"
  ADD COLUMN "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quiet_hours_start" VARCHAR(5),
  ADD COLUMN "quiet_hours_end" VARCHAR(5),
  ADD COLUMN "quiet_hours_allow_urgent" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "agent_alert_subscriptions" (
  "id"                 SERIAL PRIMARY KEY,
  "workspace_id"       INTEGER NOT NULL,
  "technician_id"      INTEGER NOT NULL,
  "label"              VARCHAR(120),
  "category_id"        INTEGER,
  "tag_id"             INTEGER,
  "priority_min"       INTEGER,
  "on_created"         BOOLEAN NOT NULL DEFAULT true,
  "on_priority_raised" BOOLEAN NOT NULL DEFAULT false,
  "on_recategorized"   BOOLEAN NOT NULL DEFAULT false,
  "channel_email"      BOOLEAN NOT NULL DEFAULT true,
  "channel_sms"        BOOLEAN NOT NULL DEFAULT false,
  "channel_whatsapp"   BOOLEAN NOT NULL DEFAULT false,
  "channel_phone"      BOOLEAN NOT NULL DEFAULT false,
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_alert_subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_alert_subscriptions_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_alert_subscriptions_workspace_id_is_active_idx" ON "agent_alert_subscriptions"("workspace_id", "is_active");
CREATE INDEX "agent_alert_subscriptions_technician_id_idx" ON "agent_alert_subscriptions"("technician_id");
CREATE INDEX "agent_alert_subscriptions_category_id_idx" ON "agent_alert_subscriptions"("category_id");
CREATE INDEX "agent_alert_subscriptions_tag_id_idx" ON "agent_alert_subscriptions"("tag_id");

CREATE TABLE "agent_alert_events" (
  "id"              SERIAL PRIMARY KEY,
  "workspace_id"    INTEGER NOT NULL,
  "subscription_id" INTEGER NOT NULL,
  "technician_id"   INTEGER NOT NULL,
  "ticket_id"       INTEGER NOT NULL,
  "trigger"         VARCHAR(20) NOT NULL,
  "priority"        INTEGER,
  "matched_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"         TIMESTAMP(3),
  "delivery_result" JSONB,
  CONSTRAINT "agent_alert_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "agent_alert_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_alert_events_subscription_id_ticket_id_trigger_key" ON "agent_alert_events"("subscription_id", "ticket_id", "trigger");
CREATE INDEX "agent_alert_events_subscription_id_sent_at_idx" ON "agent_alert_events"("subscription_id", "sent_at");
CREATE INDEX "agent_alert_events_workspace_id_sent_at_idx" ON "agent_alert_events"("workspace_id", "sent_at");
