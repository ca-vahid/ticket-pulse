-- Create-form presets (recurring request shapes).
CREATE TABLE IF NOT EXISTS "ticket_templates" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "subject" VARCHAR(500),
  "description" TEXT,
  "priority" INTEGER,
  "ticket_type" VARCHAR(30),
  "internal_category_id" INTEGER,
  "internal_subcategory_id" INTEGER,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ticket_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_templates_workspace_id_name_key"
  ON "ticket_templates"("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "ticket_templates_workspace_id_is_active_idx"
  ON "ticket_templates"("workspace_id", "is_active");
