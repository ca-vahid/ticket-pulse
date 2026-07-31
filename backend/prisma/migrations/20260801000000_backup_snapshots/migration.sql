-- Backup & Restore (BACKUP_RESTORE_PLAN Phase 2/3): app-level snapshots +
-- schedules. Additive; safe to re-apply.
CREATE TABLE IF NOT EXISTS "backup_snapshots" (
    "id" SERIAL NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "workspace_id" INTEGER,
    "tier" VARCHAR(20) NOT NULL DEFAULT 'config',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "trigger" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "blob_name" VARCHAR(300),
    "size_bytes" INTEGER,
    "manifest" JSONB,
    "created_by_email" VARCHAR(255),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "backup_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "backup_snapshots_workspace_id_idx" ON "backup_snapshots"("workspace_id");
CREATE INDEX IF NOT EXISTS "backup_snapshots_created_at_idx" ON "backup_snapshots"("created_at");

CREATE TABLE IF NOT EXISTS "backup_schedules" (
    "id" SERIAL NOT NULL,
    "scope" VARCHAR(20) NOT NULL,
    "workspace_id" INTEGER,
    "tier" VARCHAR(20) NOT NULL DEFAULT 'config',
    "frequency" VARCHAR(20) NOT NULL DEFAULT 'daily',
    "hour_utc" INTEGER NOT NULL DEFAULT 9,
    "weekday" INTEGER,
    "retention_count" INTEGER NOT NULL DEFAULT 14,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "backup_schedules_pkey" PRIMARY KEY ("id")
);
