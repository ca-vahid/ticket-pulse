-- Ticket-type registry: per-workspace catalogue of ticket types, optionally
-- mapped to a FreshService ticket_type form-field choice.
CREATE TABLE "ticket_type_definitions" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "description" TEXT,
    "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "fs_type_value" VARCHAR(40),
    "fs_choice_id" BIGINT,
    "fs_detected_at" TIMESTAMP(3),
    "ai_assignable" BOOLEAN NOT NULL DEFAULT true,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "color" VARCHAR(20) NOT NULL DEFAULT 'slate',
    "abbreviation" VARCHAR(6),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source" VARCHAR(20) NOT NULL DEFAULT 'fs_sync',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_type_definitions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ticket_type_definitions"
    ADD CONSTRAINT "ticket_type_definitions_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ticket_type_definitions_workspace_id_name_key"
    ON "ticket_type_definitions"("workspace_id", "name");
CREATE INDEX "ticket_type_definitions_workspace_id_is_active_idx"
    ON "ticket_type_definitions"("workspace_id", "is_active");

-- SLA policies gain an optional type dimension. Existing rows keep
-- ticket_type_id NULL = the "all types" fallback row — behavior-preserving.
ALTER TABLE "sla_policies" ADD COLUMN "ticket_type_id" INTEGER;

ALTER TABLE "sla_policies"
    ADD CONSTRAINT "sla_policies_ticket_type_id_fkey"
    FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_type_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX "sla_policies_workspace_id_priority_key";
CREATE UNIQUE INDEX "sla_policies_workspace_id_priority_ticket_type_id_key"
    ON "sla_policies"("workspace_id", "priority", "ticket_type_id");
-- Postgres treats NULLs as distinct in the composite unique — enforce a
-- single fallback row per (workspace, priority) with a partial unique index.
CREATE UNIQUE INDEX "sla_policies_fallback_unique"
    ON "sla_policies"("workspace_id", "priority") WHERE "ticket_type_id" IS NULL;

-- Per-workspace FS type write-back gate (replaces the env-based
-- SKILL_HIERARCHY_WORKSPACE_IDS gate for type). Seed ws1 true so IT's
-- current behavior is unchanged on deploy.
ALTER TABLE "assignment_configs" ADD COLUMN "type_writeback_enabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "assignment_configs" SET "type_writeback_enabled" = true WHERE "workspace_id" = 1;
