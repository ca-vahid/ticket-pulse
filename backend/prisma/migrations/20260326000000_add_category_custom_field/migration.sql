-- Add configurable custom field name for ticket category per workspace
ALTER TABLE "workspaces" ADD COLUMN "category_custom_field" VARCHAR(100) NOT NULL DEFAULT 'security';

-- Set Accounting workspace to use 'case_type' instead of 'security'
UPDATE "workspaces" SET "category_custom_field" = 'case_type' WHERE "slug" = 'accounting';
