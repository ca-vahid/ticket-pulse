-- Vacation Pulse: leave types per workspace, and a settings change history
-- (26 Nov 2026).
--
-- av_leave_type_workspaces: a workspace admin switches a shared leave type
-- off (or back on) for their own workspace only. No row means the type is on
-- there, so nothing changes until a workspace switches one off.
--
-- av_settings_changes: every Vacation Pulse settings change, append-only:
-- who, when, what, before and after.
--
-- Additive only: two new tables and their indexes, nothing on existing
-- tables changes. Safe to run twice.

CREATE TABLE IF NOT EXISTS "av_leave_type_workspaces" (
  "id" SERIAL NOT NULL,
  "leave_type_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "updated_by" TEXT,
  CONSTRAINT "av_leave_type_workspaces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "av_leave_type_workspaces_leave_type_id_workspace_id_key"
  ON "av_leave_type_workspaces" ("leave_type_id", "workspace_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'av_leave_type_workspaces_leave_type_id_fkey') THEN
    ALTER TABLE "av_leave_type_workspaces"
      ADD CONSTRAINT "av_leave_type_workspaces_leave_type_id_fkey"
      FOREIGN KEY ("leave_type_id") REFERENCES "av_leave_types"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "av_settings_changes" (
  "id" SERIAL NOT NULL,
  "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
  "actor" TEXT NOT NULL,
  "workspace_id" INTEGER,
  "entity" TEXT NOT NULL,
  "entity_id" TEXT,
  "action" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  CONSTRAINT "av_settings_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_av_settings_changes_created"
  ON "av_settings_changes" ("created_at" DESC);
