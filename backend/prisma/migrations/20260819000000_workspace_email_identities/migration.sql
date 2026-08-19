-- Per-workspace outbound sender identity (Mega 08-18 Phase EB): the From
-- display name used for SendGrid sends from a workspace, e.g.
-- "Ticket Pulse IT" <ticketpulse@bgcengineering.ca>. NULL from_name means
-- inherit the global default (app_settings.sendgrid_from_name, falling back
-- to 'Ticket Pulse'). Idempotent; safe to re-apply.
CREATE TABLE IF NOT EXISTS "workspace_email_identities" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "from_name" VARCHAR(80),
    "updated_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_email_identities_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    ALTER TABLE "workspace_email_identities"
        ADD CONSTRAINT "workspace_email_identities_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_email_identities_workspace_id_key"
    ON "workspace_email_identities"("workspace_id");
