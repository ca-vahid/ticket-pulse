-- Mega 08-23 Phases FC + TF (v3.6.03-preview). Idempotent; safe to re-apply.
--
-- FC3: queue_card_configs — admin-chosen quick filter cards on /tickets.
--   `cards` = ordered JSON array of exactly 6 registry keys (validated at the
--   route). Absent row = today's default 6 (zero behavior change).
-- TF1: ticket_form_configs — admin-editable new-ticket form per workspace
--   (built-in field visibility/required/defaults + workspace default source /
--   default FS group preselect), plus custom_field_definitions gains
--   is_required_on_create + default_value.

CREATE TABLE IF NOT EXISTS "queue_card_configs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "cards" JSONB NOT NULL,
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_card_configs_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "queue_card_configs"
        ADD CONSTRAINT "queue_card_configs_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "queue_card_configs_workspace_id_key"
    ON "queue_card_configs"("workspace_id");

CREATE TABLE IF NOT EXISTS "ticket_form_configs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "fields" JSONB,
    "default_source" INTEGER,
    "default_group_id" BIGINT,
    "defaults" JSONB,
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_form_configs_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "ticket_form_configs"
        ADD CONSTRAINT "ticket_form_configs_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_form_configs_workspace_id_key"
    ON "ticket_form_configs"("workspace_id");

ALTER TABLE "custom_field_definitions"
    ADD COLUMN IF NOT EXISTS "is_required_on_create" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "custom_field_definitions"
    ADD COLUMN IF NOT EXISTS "default_value" VARCHAR(2000);
