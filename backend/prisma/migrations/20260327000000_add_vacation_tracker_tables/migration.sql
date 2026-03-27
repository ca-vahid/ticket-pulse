-- Vacation Tracker integration tables
-- Per-workspace config, leave type mappings, user-to-technician matching, and synced leave records

-- 1. Vacation Tracker config (one per workspace)
CREATE TABLE "vacation_tracker_configs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "api_key" TEXT NOT NULL,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vacation_tracker_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vacation_tracker_configs_workspace_id_key" ON "vacation_tracker_configs"("workspace_id");

ALTER TABLE "vacation_tracker_configs" ADD CONSTRAINT "vacation_tracker_configs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. VT leave type to category mapping
CREATE TABLE "vt_leave_types" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "vt_leave_type_id" VARCHAR(255) NOT NULL,
    "vt_leave_type_name" VARCHAR(255) NOT NULL,
    "category" VARCHAR(20) NOT NULL DEFAULT 'OTHER',
    "color" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vt_leave_types_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vt_leave_types_workspace_id_idx" ON "vt_leave_types"("workspace_id");
CREATE UNIQUE INDEX "vt_leave_types_workspace_id_vt_leave_type_id_key" ON "vt_leave_types"("workspace_id", "vt_leave_type_id");

ALTER TABLE "vt_leave_types" ADD CONSTRAINT "vt_leave_types_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. VT user to technician mapping
CREATE TABLE "vt_user_mappings" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "vt_user_id" VARCHAR(255) NOT NULL,
    "vt_user_name" VARCHAR(255) NOT NULL,
    "vt_user_email" VARCHAR(255) NOT NULL,
    "technician_id" INTEGER,
    "match_status" VARCHAR(20) NOT NULL DEFAULT 'unmatched',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vt_user_mappings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vt_user_mappings_workspace_id_idx" ON "vt_user_mappings"("workspace_id");
CREATE INDEX "vt_user_mappings_technician_id_idx" ON "vt_user_mappings"("technician_id");
CREATE UNIQUE INDEX "vt_user_mappings_workspace_id_vt_user_id_key" ON "vt_user_mappings"("workspace_id", "vt_user_id");

ALTER TABLE "vt_user_mappings" ADD CONSTRAINT "vt_user_mappings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vt_user_mappings" ADD CONSTRAINT "vt_user_mappings_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Synced leave records (one row per day per technician)
CREATE TABLE "technician_leaves" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "vt_leave_id" VARCHAR(255) NOT NULL,
    "leave_date" DATE NOT NULL,
    "leave_type_name" VARCHAR(255) NOT NULL,
    "category" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technician_leaves_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "technician_leaves_workspace_id_leave_date_idx" ON "technician_leaves"("workspace_id", "leave_date");
CREATE INDEX "technician_leaves_technician_id_leave_date_idx" ON "technician_leaves"("technician_id", "leave_date");
CREATE UNIQUE INDEX "technician_leaves_vt_leave_id_leave_date_key" ON "technician_leaves"("vt_leave_id", "leave_date");

ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "technician_leaves" ADD CONSTRAINT "technician_leaves_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
