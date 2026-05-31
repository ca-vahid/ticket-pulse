CREATE TABLE "notification_email_signatures" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "html" TEXT,
  "text" TEXT,
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_email_signatures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_email_signatures_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "notification_email_signatures_workspace_id_key"
  ON "notification_email_signatures"("workspace_id");

CREATE INDEX "notification_email_signatures_workspace_id_idx"
  ON "notification_email_signatures"("workspace_id");
