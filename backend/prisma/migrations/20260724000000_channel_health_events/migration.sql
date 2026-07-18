-- Notification channel health events: one row per outbound delivery attempt
-- (email now; channel field extensible to sms/whatsapp/voice). Lets the app
-- surface delivery failures instead of swallowing them.
CREATE TABLE "notification_channel_health_events" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER,
    "channel" VARCHAR(20) NOT NULL,
    "context" VARCHAR(60),
    "provider" VARCHAR(40),
    "success" BOOLEAN NOT NULL,
    "error_class" VARCHAR(50),
    "status_code" INTEGER,
    "recipient_domain" VARCHAR(120),
    "duration_ms" INTEGER,
    "sanitized_message" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channel_health_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notification_channel_health_events_channel_created_at_idx" ON "notification_channel_health_events"("channel", "created_at");
CREATE INDEX "notification_channel_health_events_success_created_at_idx" ON "notification_channel_health_events"("success", "created_at");
CREATE INDEX "notification_channel_health_events_workspace_id_created_at_idx" ON "notification_channel_health_events"("workspace_id", "created_at");

ALTER TABLE "notification_channel_health_events" ADD CONSTRAINT "notification_channel_health_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
