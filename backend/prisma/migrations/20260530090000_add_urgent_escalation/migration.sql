-- Workspace-scoped urgent escalation policies, selected recipients, and audit events.

CREATE TABLE "urgent_escalation_policies" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "automatic_enabled" BOOLEAN NOT NULL DEFAULT false,
  "self_service_enabled" BOOLEAN NOT NULL DEFAULT false,
  "cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
  "confirmation_title" VARCHAR(160) NOT NULL DEFAULT 'Request urgent after-hours assistance',
  "confirmation_body" TEXT,
  "legacy_channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "legacy_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "legacy_phones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_escalation_policies_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "urgent_escalation_policies_workspace_id_key"
  ON "urgent_escalation_policies"("workspace_id");
CREATE INDEX "urgent_escalation_policies_workspace_id_idx"
  ON "urgent_escalation_policies"("workspace_id");

CREATE TABLE "urgent_escalation_recipients" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "policy_id" INTEGER NOT NULL,
  "technician_id" INTEGER NOT NULL,
  "scope" VARCHAR(30) NOT NULL DEFAULT 'base',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_escalation_recipients_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_recipients_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "urgent_escalation_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_recipients_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "urgent_escalation_recipients_workspace_id_technician_id_scope_key"
  ON "urgent_escalation_recipients"("workspace_id", "technician_id", "scope");
CREATE INDEX "urgent_escalation_recipients_workspace_id_scope_idx"
  ON "urgent_escalation_recipients"("workspace_id", "scope");
CREATE INDEX "urgent_escalation_recipients_policy_id_idx"
  ON "urgent_escalation_recipients"("policy_id");
CREATE INDEX "urgent_escalation_recipients_technician_id_idx"
  ON "urgent_escalation_recipients"("technician_id");

CREATE TABLE "urgent_escalation_events" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "policy_id" INTEGER,
  "ticket_id" INTEGER NOT NULL,
  "public_status_link_id" INTEGER,
  "pipeline_run_id" INTEGER,
  "source" VARCHAR(30) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'submitted',
  "triggered_by" VARCHAR(120),
  "ip_hash" VARCHAR(64),
  "user_agent" VARCHAR(500),
  "priority_writeback_status" VARCHAR(30),
  "priority_writeback_error" TEXT,
  "notification_summary" JSONB,
  "cooldown_until" TIMESTAMP(3),
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_escalation_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_events_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "urgent_escalation_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_events_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_events_public_status_link_id_fkey"
    FOREIGN KEY ("public_status_link_id") REFERENCES "public_ticket_status_links"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "urgent_escalation_events_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "urgent_escalation_events_workspace_id_created_at_idx"
  ON "urgent_escalation_events"("workspace_id", "created_at");
CREATE INDEX "urgent_escalation_events_ticket_id_created_at_idx"
  ON "urgent_escalation_events"("ticket_id", "created_at");
CREATE INDEX "urgent_escalation_events_public_status_link_id_idx"
  ON "urgent_escalation_events"("public_status_link_id");
CREATE INDEX "urgent_escalation_events_pipeline_run_id_idx"
  ON "urgent_escalation_events"("pipeline_run_id");
CREATE INDEX "urgent_escalation_events_source_status_idx"
  ON "urgent_escalation_events"("source", "status");

ALTER TABLE "notification_deliveries"
  ADD COLUMN "urgent_escalation_event_id" INTEGER;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_urgent_escalation_event_id_fkey"
  FOREIGN KEY ("urgent_escalation_event_id") REFERENCES "urgent_escalation_events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "notification_deliveries_urgent_escalation_event_id_idx"
  ON "notification_deliveries"("urgent_escalation_event_id");

-- Preserve existing assignment configuration as a new policy and legacy recipients.
INSERT INTO "urgent_escalation_policies" (
  "workspace_id",
  "automatic_enabled",
  "self_service_enabled",
  "cooldown_minutes",
  "legacy_channels",
  "legacy_emails",
  "legacy_phones",
  "updated_by",
  "created_at",
  "updated_at"
)
SELECT
  "workspace_id",
  "after_hours_urgent_escalation_enabled",
  false,
  60,
  COALESCE("after_hours_urgent_escalation_channels", ARRAY[]::TEXT[]),
  COALESCE("after_hours_urgent_escalation_emails", ARRAY[]::TEXT[]),
  COALESCE("after_hours_urgent_escalation_phones", ARRAY[]::TEXT[]),
  'migration',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "assignment_configs"
WHERE "after_hours_urgent_escalation_enabled" = true
  OR COALESCE(array_length("after_hours_urgent_escalation_channels", 1), 0) > 0
  OR COALESCE(array_length("after_hours_urgent_escalation_emails", 1), 0) > 0
  OR COALESCE(array_length("after_hours_urgent_escalation_phones", 1), 0) > 0
ON CONFLICT ("workspace_id") DO NOTHING;

-- Match legacy email recipients to workspace technicians where possible.
INSERT INTO "urgent_escalation_recipients" (
  "workspace_id",
  "policy_id",
  "technician_id",
  "scope",
  "created_at",
  "updated_at"
)
SELECT DISTINCT
  p."workspace_id",
  p."id",
  t."id",
  'base',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "urgent_escalation_policies" p
JOIN "assignment_configs" ac ON ac."workspace_id" = p."workspace_id"
JOIN LATERAL unnest(COALESCE(ac."after_hours_urgent_escalation_emails", ARRAY[]::TEXT[])) AS legacy_email("value") ON true
JOIN "technicians" t
  ON t."workspace_id" = p."workspace_id"
 AND t."email" IS NOT NULL
 AND lower(t."email") = lower(trim(legacy_email."value"))
ON CONFLICT ("workspace_id", "technician_id", "scope") DO NOTHING;

-- Match legacy phone recipients to technicians with notification preference phones where possible.
INSERT INTO "urgent_escalation_recipients" (
  "workspace_id",
  "policy_id",
  "technician_id",
  "scope",
  "created_at",
  "updated_at"
)
SELECT DISTINCT
  p."workspace_id",
  p."id",
  np."technician_id",
  'base',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "urgent_escalation_policies" p
JOIN "assignment_configs" ac ON ac."workspace_id" = p."workspace_id"
JOIN LATERAL unnest(COALESCE(ac."after_hours_urgent_escalation_phones", ARRAY[]::TEXT[])) AS legacy_phone("value") ON true
JOIN "technician_notification_preferences" np
  ON np."workspace_id" = p."workspace_id"
 AND (
   regexp_replace(COALESCE(np."phone_override", ''), '[^0-9+]', '', 'g') = regexp_replace(legacy_phone."value", '[^0-9+]', '', 'g')
   OR regexp_replace(COALESCE(np."entra_mobile_phone", ''), '[^0-9+]', '', 'g') = regexp_replace(legacy_phone."value", '[^0-9+]', '', 'g')
   OR regexp_replace(COALESCE(np."entra_phone", ''), '[^0-9+]', '', 'g') = regexp_replace(legacy_phone."value", '[^0-9+]', '', 'g')
 )
ON CONFLICT ("workspace_id", "technician_id", "scope") DO NOTHING;
