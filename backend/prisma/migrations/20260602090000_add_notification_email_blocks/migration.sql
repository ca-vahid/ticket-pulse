CREATE TABLE "notification_email_blocks" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "html" TEXT,
  "text" TEXT,
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_email_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_email_blocks_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "notification_email_blocks_workspace_id_idx"
  ON "notification_email_blocks"("workspace_id");

CREATE INDEX "notification_email_blocks_workspace_id_type_idx"
  ON "notification_email_blocks"("workspace_id", "type");

CREATE INDEX "notification_email_blocks_workspace_id_type_is_default_idx"
  ON "notification_email_blocks"("workspace_id", "type", "is_default");

CREATE UNIQUE INDEX "notification_email_blocks_one_default_per_type"
  ON "notification_email_blocks"("workspace_id", "type")
  WHERE "is_default" = true;

INSERT INTO "notification_email_blocks" (
  "workspace_id",
  "type",
  "name",
  "enabled",
  "is_default",
  "html",
  "text",
  "updated_by",
  "created_at",
  "updated_at"
)
SELECT
  signature."workspace_id",
  'footer',
  'Default footer',
  signature."enabled",
  true,
  signature."html",
  signature."text",
  signature."updated_by",
  signature."created_at",
  signature."updated_at"
FROM "notification_email_signatures" signature
WHERE (
  signature."enabled" = true
  OR COALESCE(signature."html", '') <> ''
  OR COALESCE(signature."text", '') <> ''
)
AND NOT EXISTS (
  SELECT 1
  FROM "notification_email_blocks" existing
  WHERE existing."workspace_id" = signature."workspace_id"
    AND existing."type" = 'footer'
    AND existing."is_default" = true
);
