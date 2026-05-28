CREATE TABLE "workspace_webhook_configs" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "secret_hash" VARCHAR(255),
  "secret_last4" VARCHAR(8),
  "last_received_at" TIMESTAMP(3),
  "last_accepted_at" TIMESTAMP(3),
  "last_rejected_at" TIMESTAMP(3),
  "last_error_at" TIMESTAMP(3),
  "last_error_message" TEXT,
  "received_count" INTEGER NOT NULL DEFAULT 0,
  "accepted_count" INTEGER NOT NULL DEFAULT 0,
  "rejected_count" INTEGER NOT NULL DEFAULT 0,
  "error_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "workspace_webhook_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_webhook_configs_workspace_id_key"
  ON "workspace_webhook_configs"("workspace_id");

CREATE INDEX "workspace_webhook_configs_workspace_id_enabled_idx"
  ON "workspace_webhook_configs"("workspace_id", "enabled");

ALTER TABLE "workspace_webhook_configs"
  ADD CONSTRAINT "workspace_webhook_configs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id")
  REFERENCES "workspaces"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
