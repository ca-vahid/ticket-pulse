CREATE TABLE IF NOT EXISTS "notification_workflow_policies" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL UNIQUE,
  "after_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  "holidays_enabled" BOOLEAN NOT NULL DEFAULT true,
  "suppress_standard_ticket_created" BOOLEAN NOT NULL DEFAULT true,
  "off_hours_workflow_key" VARCHAR(80) NOT NULL DEFAULT 'ticket_created_after_hours',
  "emergency_support_url" TEXT,
  "emergency_support_label" VARCHAR(160),
  "off_hours_message" TEXT,
  "holiday_message" TEXT,
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_workflow_policies_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "notification_workflow_policies_workspace_id_idx"
  ON "notification_workflow_policies"("workspace_id");
