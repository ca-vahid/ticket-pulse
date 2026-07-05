-- Native ticketing catch-up: schema changes made in dev via raw SQL after the
-- 20260704 migration (approvals v2 categories, saved views, internal-group
-- membership, local agents, mirror-job payload). All additive + one constraint
-- relaxation (technicians.freshservice_id nullable for local agents). No data
-- is modified; existing rows and settings are preserved.

-- ---- New tables -----------------------------------------------------------

CREATE TABLE "approval_categories" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "manager_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_members" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "saved_filter_views" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "owner_email" VARCHAR(255) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "params" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_filter_views_pkey" PRIMARY KEY ("id")
);

-- ---- New columns ----------------------------------------------------------

ALTER TABLE "groups" ADD COLUMN "origin" VARCHAR(20) NOT NULL DEFAULT 'freshservice';

ALTER TABLE "mailbox_connections" ADD COLUMN "default_internal_group_id" INTEGER;

ALTER TABLE "mirror_jobs" ADD COLUMN "payload" JSONB;

ALTER TABLE "technicians" ADD COLUMN "origin" VARCHAR(20) NOT NULL DEFAULT 'freshservice';
ALTER TABLE "technicians" ALTER COLUMN "freshservice_id" DROP NOT NULL;

ALTER TABLE "ticket_approvals" ADD COLUMN "approval_category_id" INTEGER,
ADD COLUMN "request_group_id" VARCHAR(64);

ALTER TABLE "tickets" ADD COLUMN "internal_group_id" INTEGER;

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX "approval_categories_workspace_id_is_active_idx" ON "approval_categories"("workspace_id", "is_active");
CREATE UNIQUE INDEX "approval_categories_workspace_id_name_key" ON "approval_categories"("workspace_id", "name");
CREATE INDEX "group_members_group_id_idx" ON "group_members"("group_id");
CREATE UNIQUE INDEX "group_members_group_id_technician_id_key" ON "group_members"("group_id", "technician_id");
CREATE INDEX "group_members_technician_id_idx" ON "group_members"("technician_id");
CREATE INDEX "group_members_workspace_id_idx" ON "group_members"("workspace_id");
CREATE INDEX "saved_filter_views_ws_owner_idx" ON "saved_filter_views"("workspace_id", "owner_email");
CREATE INDEX "saved_filter_views_ws_shared_idx" ON "saved_filter_views"("workspace_id", "shared");
CREATE INDEX "groups_origin_idx" ON "groups"("origin");
CREATE INDEX "technicians_origin_idx" ON "technicians"("origin");
CREATE INDEX "ticket_approvals_request_group_id_idx" ON "ticket_approvals"("request_group_id");

-- ---- Foreign keys (new relations only) ------------------------------------

ALTER TABLE "approval_categories" ADD CONSTRAINT "approval_categories_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_default_internal_group_id_fkey" FOREIGN KEY ("default_internal_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ticket_approvals" ADD CONSTRAINT "ticket_approvals_approval_category_id_fkey" FOREIGN KEY ("approval_category_id") REFERENCES "approval_categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_internal_group_id_fkey" FOREIGN KEY ("internal_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
