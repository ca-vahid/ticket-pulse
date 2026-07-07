-- Outbound webhooks for integrations (gap plan 2, Phase 3).

CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "url" VARCHAR(1000) NOT NULL,
    "secret" VARCHAR(64) NOT NULL,
    "events" TEXT[] NOT NULL DEFAULT '{}',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_at" TIMESTAMP(3),
    "last_error" TEXT,
    "recent_deliveries" JSONB,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "webhook_subscriptions_workspace_id_is_enabled_idx"
    ON "webhook_subscriptions"("workspace_id", "is_enabled");

DO $$ BEGIN
    ALTER TABLE "webhook_subscriptions"
        ADD CONSTRAINT "webhook_subscriptions_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
