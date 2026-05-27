-- Priority assessment and agent notification scaffolding.

ALTER TABLE "tickets"
  ADD COLUMN "assessed_priority" VARCHAR(20),
  ADD COLUMN "assessed_priority_id" INTEGER,
  ADD COLUMN "priority_rationale" TEXT,
  ADD COLUMN "priority_confidence" VARCHAR(20),
  ADD COLUMN "priority_evidence" JSONB,
  ADD COLUMN "priority_assessed_at" TIMESTAMP(3),
  ADD COLUMN "priority_assessed_by_run_id" INTEGER;

CREATE INDEX "tickets_assessed_priority_id_idx" ON "tickets"("assessed_priority_id");
CREATE INDEX "tickets_priority_assessed_at_idx" ON "tickets"("priority_assessed_at");

ALTER TABLE "assignment_configs"
  ADD COLUMN "priority_assessment_after_hours_enabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN "priority_writeback_status" VARCHAR(20),
  ADD COLUMN "priority_writeback_payload" JSONB,
  ADD COLUMN "priority_writeback_error" TEXT,
  ADD COLUMN "priority_written_at" TIMESTAMP(3);

CREATE TABLE "technician_notification_preferences" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "technician_id" INTEGER NOT NULL,
  "threshold" VARCHAR(20) NOT NULL DEFAULT 'high_urgent',
  "email_enabled" BOOLEAN NOT NULL DEFAULT false,
  "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
  "phone_call_enabled" BOOLEAN NOT NULL DEFAULT false,
  "entra_phone" VARCHAR(50),
  "entra_mobile_phone" VARCHAR(50),
  "phone_override" VARCHAR(50),
  "phone_verified_at" TIMESTAMP(3),
  "phone_verification_code" VARCHAR(20),
  "phone_verification_requested_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "technician_notification_preferences_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "technician_notification_preferences_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "technician_notification_preferences_technician_id_key"
  ON "technician_notification_preferences"("technician_id");
CREATE UNIQUE INDEX "technician_notification_preferences_workspace_id_technician_id_key"
  ON "technician_notification_preferences"("workspace_id", "technician_id");
CREATE INDEX "technician_notification_preferences_workspace_id_idx"
  ON "technician_notification_preferences"("workspace_id");
CREATE INDEX "technician_notification_preferences_technician_id_idx"
  ON "technician_notification_preferences"("technician_id");

CREATE TABLE "notification_deliveries" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "technician_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "pipeline_run_id" INTEGER NOT NULL,
  "channel" VARCHAR(20) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'queued',
  "assessed_priority" VARCHAR(20) NOT NULL,
  "recipient" VARCHAR(255),
  "provider" VARCHAR(50),
  "provider_message_id" VARCHAR(255),
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "payload" JSONB,
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_deliveries_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_deliveries_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_deliveries_dedupe_key_key"
  ON "notification_deliveries"("dedupe_key");
CREATE INDEX "notification_deliveries_workspace_id_status_idx"
  ON "notification_deliveries"("workspace_id", "status");
CREATE INDEX "notification_deliveries_technician_id_idx"
  ON "notification_deliveries"("technician_id");
CREATE INDEX "notification_deliveries_ticket_id_idx"
  ON "notification_deliveries"("ticket_id");
CREATE INDEX "notification_deliveries_pipeline_run_id_idx"
  ON "notification_deliveries"("pipeline_run_id");
CREATE INDEX "notification_deliveries_channel_idx"
  ON "notification_deliveries"("channel");
