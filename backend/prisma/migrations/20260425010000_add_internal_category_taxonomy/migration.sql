-- Add two-level internal taxonomy metadata to competency categories.
ALTER TABLE "competency_categories"
  ADD COLUMN "parent_id" INTEGER,
  ADD COLUMN "is_system_suggested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source" VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "competency_categories"
  ADD CONSTRAINT "competency_categories_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "competency_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "competency_categories_workspace_id_parent_id_idx"
  ON "competency_categories"("workspace_id", "parent_id");

CREATE INDEX "competency_categories_parent_id_idx"
  ON "competency_categories"("parent_id");

-- Persist app-owned ticket classification separately from FreshService evidence fields.
ALTER TABLE "tickets"
  ADD COLUMN "internal_category_id" INTEGER,
  ADD COLUMN "internal_subcategory_id" INTEGER,
  ADD COLUMN "internal_category_confidence" VARCHAR(20),
  ADD COLUMN "internal_category_rationale" TEXT;

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_internal_category_id_fkey"
  FOREIGN KEY ("internal_category_id") REFERENCES "competency_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_internal_subcategory_id_fkey"
  FOREIGN KEY ("internal_subcategory_id") REFERENCES "competency_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tickets_internal_category_id_idx" ON "tickets"("internal_category_id");
CREATE INDEX "tickets_internal_subcategory_id_idx" ON "tickets"("internal_subcategory_id");
