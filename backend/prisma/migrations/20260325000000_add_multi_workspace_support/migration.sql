-- Multi-workspace support migration
-- Adds Workspace and WorkspaceAccess tables, adds workspace_id FK to all tenant-scoped tables
-- Backfills all existing data into workspace 1 (IT, freshservice_workspace_id = 2)

-- 1. Create workspaces table
CREATE TABLE "workspaces" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(50) NOT NULL,
    "freshservice_workspace_id" BIGINT NOT NULL,
    "default_timezone" VARCHAR(50) NOT NULL DEFAULT 'America/Los_Angeles',
    "sync_interval_minutes" INTEGER NOT NULL DEFAULT 5,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- 2. Create workspace_access table
CREATE TABLE "workspace_access" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_access_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workspace_access_email_idx" ON "workspace_access"("email");
CREATE UNIQUE INDEX "workspace_access_email_workspace_id_key" ON "workspace_access"("email", "workspace_id");

ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Seed IT workspace (id=1) using the existing freshservice_workspace_id from app_settings
-- Default to workspace_id 2 if not found in settings
INSERT INTO "workspaces" ("name", "slug", "freshservice_workspace_id", "default_timezone", "sync_interval_minutes")
SELECT
    'IT',
    'it',
    COALESCE(
        (SELECT "value"::bigint FROM "app_settings" WHERE "key" = 'freshservice_workspace_id'),
        2
    ),
    COALESCE(
        (SELECT "value" FROM "app_settings" WHERE "key" = 'default_timezone'),
        'America/Los_Angeles'
    ),
    COALESCE(
        (SELECT "value"::integer FROM "app_settings" WHERE "key" = 'sync_interval_minutes'),
        5
    );

-- 4. Technicians: change workspace_id from BigInt (FS workspace ID) to Int (FK to workspaces)
-- Drop old index first
DROP INDEX IF EXISTS "technicians_workspace_id_idx";

-- Drop old column and add new one
ALTER TABLE "technicians" DROP COLUMN "workspace_id";
ALTER TABLE "technicians" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;

-- Add FK constraint and index
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "technicians_workspace_id_idx" ON "technicians"("workspace_id");

-- 5. Tickets: add workspace_id
ALTER TABLE "tickets" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "tickets_workspace_id_idx" ON "tickets"("workspace_id");

-- 6. Sync logs: add workspace_id
ALTER TABLE "sync_logs" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "sync_logs_workspace_id_idx" ON "sync_logs"("workspace_id");

-- 7. Noise rules: add workspace_id
ALTER TABLE "noise_rules" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "noise_rules" ADD CONSTRAINT "noise_rules_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "noise_rules_workspace_id_idx" ON "noise_rules"("workspace_id");

-- 8. Business hours: add workspace_id
ALTER TABLE "business_hours" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "business_hours_workspace_id_idx" ON "business_hours"("workspace_id");

-- 9. Holidays: add workspace_id (nullable — null means shared across all workspaces)
ALTER TABLE "holidays" ADD COLUMN "workspace_id" INTEGER;
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "holidays_workspace_id_idx" ON "holidays"("workspace_id");

-- 10. Auto responses: add workspace_id
ALTER TABLE "auto_responses" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "auto_responses" ADD CONSTRAINT "auto_responses_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "auto_responses_workspace_id_idx" ON "auto_responses"("workspace_id");

-- 11. LLM configs: add workspace_id
ALTER TABLE "llm_configs" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "llm_configs_workspace_id_idx" ON "llm_configs"("workspace_id");

-- 12. LLM config history: add workspace_id (no FK, just for filtering)
ALTER TABLE "llm_config_history" ADD COLUMN "workspace_id" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "llm_config_history_workspace_id_idx" ON "llm_config_history"("workspace_id");
