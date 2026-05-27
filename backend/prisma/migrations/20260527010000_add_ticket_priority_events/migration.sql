-- Track FreshService priority changes detected during sync so alerts and audit
-- are not tied only to Ticket Pulse assignment pipeline runs.
CREATE TABLE "ticket_priority_events" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "event_type" VARCHAR(40) NOT NULL DEFAULT 'freshservice_priority_changed',
  "source" VARCHAR(40) NOT NULL DEFAULT 'freshservice_sync',
  "from_priority_id" INTEGER,
  "from_priority_label" VARCHAR(20),
  "to_priority_id" INTEGER NOT NULL,
  "to_priority_label" VARCHAR(20) NOT NULL,
  "direction" VARCHAR(20) NOT NULL DEFAULT 'changed',
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_updated_at" TIMESTAMP(3),
  "status" VARCHAR(30) NOT NULL DEFAULT 'recorded',
  "skip_reason" TEXT,
  "notification_summary" JSONB,
  "reassessment_run_id" INTEGER,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ticket_priority_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ticket_priority_events"
  ADD CONSTRAINT "ticket_priority_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ticket_priority_events"
  ADD CONSTRAINT "ticket_priority_events_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ticket_priority_events_dedupe_key_key" ON "ticket_priority_events"("dedupe_key");
CREATE INDEX "ticket_priority_events_workspace_id_detected_at_idx" ON "ticket_priority_events"("workspace_id", "detected_at");
CREATE INDEX "ticket_priority_events_ticket_id_detected_at_idx" ON "ticket_priority_events"("ticket_id", "detected_at");
CREATE INDEX "ticket_priority_events_to_priority_id_idx" ON "ticket_priority_events"("to_priority_id");
CREATE INDEX "ticket_priority_events_status_idx" ON "ticket_priority_events"("status");
CREATE INDEX "ticket_priority_events_reassessment_run_id_idx" ON "ticket_priority_events"("reassessment_run_id");

ALTER TABLE "notification_deliveries" ALTER COLUMN "pipeline_run_id" DROP NOT NULL;
ALTER TABLE "notification_deliveries" ADD COLUMN "priority_event_id" INTEGER;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_priority_event_id_fkey"
  FOREIGN KEY ("priority_event_id") REFERENCES "ticket_priority_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "notification_deliveries_priority_event_id_idx" ON "notification_deliveries"("priority_event_id");
