-- Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md). New tables only.
CREATE TABLE "teams_conversations" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "aad_object_id" VARCHAR(64),
    "conversation_id" VARCHAR(255),
    "service_url" VARCHAR(255),
    "tenant_id" VARCHAR(64),
    "installed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "teams_conversations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "teams_conversations_email_key" ON "teams_conversations"("email");
CREATE INDEX "teams_conversations_aad_object_id_idx" ON "teams_conversations"("aad_object_id");

CREATE TABLE "notification_preferences" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "events" JSONB,
    "options" JSONB,
    "last_digest_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_preferences_workspace_id_technician_id_key" ON "notification_preferences"("workspace_id", "technician_id");

CREATE TABLE "notification_workspace_settings" (
    "workspace_id" INTEGER NOT NULL,
    "teams_enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaults" JSONB,
    "channel_webhook_url" TEXT,
    "channel_min_priority" INTEGER NOT NULL DEFAULT 3,
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "notification_workspace_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE "ticket_notification_mutes" (
    "id" SERIAL NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_notification_mutes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ticket_notification_mutes_technician_id_ticket_id_key" ON "ticket_notification_mutes"("technician_id", "ticket_id");

CREATE TABLE "teams_deliveries" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER,
    "email" VARCHAR(255) NOT NULL,
    "technician_id" INTEGER,
    "ticket_id" INTEGER,
    "event_key" VARCHAR(40) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(120),
    "activity_id" VARCHAR(255),
    "conversation_id" VARCHAR(255),
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teams_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "teams_deliveries_email_created_at_idx" ON "teams_deliveries"("email", "created_at");
CREATE INDEX "teams_deliveries_workspace_id_created_at_idx" ON "teams_deliveries"("workspace_id", "created_at");
CREATE INDEX "teams_deliveries_technician_id_status_created_at_idx" ON "teams_deliveries"("technician_id", "status", "created_at");
