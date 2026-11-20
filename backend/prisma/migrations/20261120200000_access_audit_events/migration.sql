-- Access history (20 Nov 2026). New table only; nothing existing changes.
CREATE TABLE IF NOT EXISTS "access_audit_events" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER,
  "actor_email" VARCHAR(255),
  "action" VARCHAR(40) NOT NULL,
  "target_email" VARCHAR(255),
  "target_label" VARCHAR(255),
  "old_value" VARCHAR(255),
  "new_value" VARCHAR(255),
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "access_audit_events_workspace_id_id_idx" ON "access_audit_events" ("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "access_audit_events_target_email_idx" ON "access_audit_events" ("target_email");
CREATE INDEX IF NOT EXISTS "access_audit_events_actor_email_idx" ON "access_audit_events" ("actor_email");
