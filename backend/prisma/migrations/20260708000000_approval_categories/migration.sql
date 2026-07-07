-- Approvals v2: per-workspace approval categories + category/group columns on
-- ticket_approvals. Already applied to dev via `db execute` (resolved as
-- applied); guarded so `migrate deploy` is clean on prod.

CREATE TABLE IF NOT EXISTS "approval_categories" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "manager_emails" TEXT[] NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "approval_categories_workspace_id_name_key"
    ON "approval_categories"("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "approval_categories_workspace_id_is_active_idx"
    ON "approval_categories"("workspace_id", "is_active");

DO $$ BEGIN
    ALTER TABLE "approval_categories"
        ADD CONSTRAINT "approval_categories_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "approval_category_id" INTEGER;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "request_group_id" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "ticket_approvals_request_group_id_idx"
    ON "ticket_approvals"("request_group_id");

DO $$ BEGIN
    ALTER TABLE "ticket_approvals"
        ADD CONSTRAINT "ticket_approvals_approval_category_id_fkey"
        FOREIGN KEY ("approval_category_id") REFERENCES "approval_categories"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
