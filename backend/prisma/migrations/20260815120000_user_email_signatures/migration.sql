-- Per-user email signatures (QA 08-14 #1 / Mega 08-15 Phase D): keyed by
-- (workspace, owner email), appended to OUTBOUND reply emails only — the
-- stored thread entry stays clean. Idempotent; safe to re-apply.
CREATE TABLE IF NOT EXISTS "user_email_signatures" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "owner_email" VARCHAR(255) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "html" TEXT,
    "text" TEXT,
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_email_signatures_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "user_email_signatures"
        ADD CONSTRAINT "user_email_signatures_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "user_email_signatures_workspace_id_owner_email_key"
    ON "user_email_signatures"("workspace_id", "owner_email");
