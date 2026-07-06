-- Enterprise staples: ticket links, TP SLA policies, macros, custom fields.

CREATE TABLE IF NOT EXISTS "ticket_links" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "related_ticket_id" INTEGER NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_links_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ticket_links"
  ADD CONSTRAINT "ticket_links_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_links"
  ADD CONSTRAINT "ticket_links_related_ticket_id_fkey"
  FOREIGN KEY ("related_ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_links_ticket_id_related_ticket_id_kind_key"
  ON "ticket_links"("ticket_id", "related_ticket_id", "kind");
CREATE INDEX IF NOT EXISTS "ticket_links_ticket_id_idx" ON "ticket_links"("ticket_id");
CREATE INDEX IF NOT EXISTS "ticket_links_related_ticket_id_idx" ON "ticket_links"("related_ticket_id");

CREATE TABLE IF NOT EXISTS "sla_policies" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "priority" INTEGER NOT NULL,
  "first_response_minutes" INTEGER,
  "resolve_minutes" INTEGER,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "updated_by" VARCHAR(255),
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "sla_policies_workspace_id_priority_key"
  ON "sla_policies"("workspace_id", "priority");
CREATE INDEX IF NOT EXISTS "sla_policies_workspace_id_is_active_idx"
  ON "sla_policies"("workspace_id", "is_active");

CREATE TABLE IF NOT EXISTS "ticket_macros" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "actions" JSONB NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ticket_macros_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_macros_workspace_id_name_key"
  ON "ticket_macros"("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "ticket_macros_workspace_id_is_active_idx"
  ON "ticket_macros"("workspace_id", "is_active");

CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "key" VARCHAR(60) NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "type" VARCHAR(20) NOT NULL DEFAULT 'text',
  "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "custom_field_definitions_workspace_id_key_key"
  ON "custom_field_definitions"("workspace_id", "key");
CREATE INDEX IF NOT EXISTS "custom_field_definitions_workspace_id_is_active_idx"
  ON "custom_field_definitions"("workspace_id", "is_active");

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "custom_fields" JSONB;
