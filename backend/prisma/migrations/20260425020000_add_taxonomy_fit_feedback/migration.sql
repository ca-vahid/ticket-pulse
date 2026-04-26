-- Capture assignment-agent taxonomy fit feedback for Daily Review and taxonomy maintenance.
ALTER TABLE "tickets"
  ADD COLUMN "internal_category_fit" VARCHAR(30),
  ADD COLUMN "internal_subcategory_fit" VARCHAR(30),
  ADD COLUMN "taxonomy_review_needed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "suggested_internal_category_name" VARCHAR(120),
  ADD COLUMN "suggested_internal_subcategory_name" VARCHAR(120);

CREATE INDEX "tickets_taxonomy_review_needed_idx" ON "tickets"("taxonomy_review_needed");
