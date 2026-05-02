-- Graph-backed shared calendar leave source for workspaces that do not use Vacation Tracker.

CREATE TABLE IF NOT EXISTS "calendar_leave_source_configs" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL UNIQUE,
  "provider" VARCHAR(50) NOT NULL DEFAULT 'graph_group_calendar',
  "mailbox" VARCHAR(255) NOT NULL,
  "graph_group_id" VARCHAR(255) NOT NULL,
  "timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Vancouver',
  "sync_enabled" BOOLEAN NOT NULL DEFAULT false,
  "last_sync_at" TIMESTAMPTZ,
  "lookback_days" INTEGER NOT NULL DEFAULT 7,
  "horizon_days" INTEGER NOT NULL DEFAULT 90,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "calendar_leave_source_configs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "calendar_leave_rules" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "pattern" TEXT NOT NULL,
  "category" VARCHAR(20) NOT NULL,
  "half_day_part" VARCHAR(10),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "calendar_leave_rules_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "calendar_leave_rules_workspace_id_idx" ON "calendar_leave_rules"("workspace_id");
CREATE INDEX IF NOT EXISTS "calendar_leave_rules_priority_idx" ON "calendar_leave_rules"("priority");

CREATE TABLE IF NOT EXISTS "calendar_leave_aliases" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "alias" VARCHAR(120) NOT NULL,
  "normalized_alias" VARCHAR(120) NOT NULL,
  "technician_id" INTEGER,
  "is_ignored" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "calendar_leave_aliases_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "calendar_leave_aliases_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_leave_aliases_workspace_id_normalized_alias_key"
  ON "calendar_leave_aliases"("workspace_id", "normalized_alias");
CREATE INDEX IF NOT EXISTS "calendar_leave_aliases_workspace_id_idx" ON "calendar_leave_aliases"("workspace_id");
CREATE INDEX IF NOT EXISTS "calendar_leave_aliases_technician_id_idx" ON "calendar_leave_aliases"("technician_id");

CREATE TABLE IF NOT EXISTS "calendar_leave_classifications" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "graph_event_id" TEXT NOT NULL,
  "last_modified_at" TIMESTAMPTZ,
  "event_fingerprint" VARCHAR(64) NOT NULL,
  "source" VARCHAR(20) NOT NULL,
  "classification" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "calendar_leave_classifications_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_leave_classifications_workspace_id_event_fingerprint_key"
  ON "calendar_leave_classifications"("workspace_id", "event_fingerprint");
CREATE INDEX IF NOT EXISTS "calendar_leave_classifications_workspace_id_idx"
  ON "calendar_leave_classifications"("workspace_id");
