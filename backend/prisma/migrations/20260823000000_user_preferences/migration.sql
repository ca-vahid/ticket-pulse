-- Per-user UI preferences (Mega 08-23 Phase QC — queue column layout etc.):
-- keyed by (workspace, owner email, key), value is a small JSON blob whose
-- keys are allowlisted at the route. SavedFilterView/UserEmailSignature
-- pattern — no User table exists. Idempotent; safe to re-apply.
CREATE TABLE IF NOT EXISTS "user_preferences" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "owner_email" VARCHAR(255) NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "user_preferences"
        ADD CONSTRAINT "user_preferences_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_workspace_id_owner_email_key_key"
    ON "user_preferences"("workspace_id", "owner_email", "key");
