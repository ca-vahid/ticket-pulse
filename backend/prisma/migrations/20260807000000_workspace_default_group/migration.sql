-- Workspace default internal group (QA 08-06 #1): tickets created with no
-- group land in this internal (TP-native) group automatically.
-- Idempotent: column + FK guarded so re-running (or pre-created dev DBs) is safe.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_internal_group_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_default_internal_group_id_fkey'
  ) THEN
    ALTER TABLE "workspaces"
      ADD CONSTRAINT "workspaces_default_internal_group_id_fkey"
      FOREIGN KEY ("default_internal_group_id") REFERENCES "groups"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
