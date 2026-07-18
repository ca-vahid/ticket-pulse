-- Public API v2: key hardening (expiry/rotation/mode/ip), idempotency, durable
-- rate limiting, request/audit log, and durable outbound webhook delivery.

-- ApiKey hardening
ALTER TABLE "api_keys" ADD COLUMN "mode" VARCHAR(10) NOT NULL DEFAULT 'live';
ALTER TABLE "api_keys" ADD COLUMN "expires_at" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN "revoked_at" TIMESTAMP(3);
ALTER TABLE "api_keys" ADD COLUMN "rotated_from_id" INTEGER;
ALTER TABLE "api_keys" ADD COLUMN "ip_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "api_keys" ADD COLUMN "rate_limit_per_min" INTEGER;
ALTER TABLE "api_keys" ADD COLUMN "last_used_ip" VARCHAR(64);
ALTER TABLE "api_keys" ALTER COLUMN "key_prefix" TYPE VARCHAR(24);

-- Idempotency-Key replay cache
CREATE TABLE "api_idempotency_keys" (
    "id" SERIAL NOT NULL,
    "api_key_id" INTEGER NOT NULL,
    "idem_key" VARCHAR(255) NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_idempotency_keys_api_key_id_idem_key_key" ON "api_idempotency_keys"("api_key_id", "idem_key");
CREATE INDEX "api_idempotency_keys_created_at_idx" ON "api_idempotency_keys"("created_at");

-- Durable fixed-window rate counter
CREATE TABLE "api_rate_windows" (
    "id" SERIAL NOT NULL,
    "bucket_key" VARCHAR(120) NOT NULL,
    "window_epoch" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "api_rate_windows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_rate_windows_bucket_key_window_epoch_key" ON "api_rate_windows"("bucket_key", "window_epoch");
CREATE INDEX "api_rate_windows_window_epoch_idx" ON "api_rate_windows"("window_epoch");

-- Per-request usage + audit log
CREATE TABLE "api_request_logs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER,
    "api_key_id" INTEGER,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "scope" VARCHAR(60),
    "status_code" INTEGER NOT NULL,
    "ip" VARCHAR(64),
    "request_id" VARCHAR(64),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_request_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "api_request_logs_api_key_id_created_at_idx" ON "api_request_logs"("api_key_id", "created_at");
CREATE INDEX "api_request_logs_workspace_id_created_at_idx" ON "api_request_logs"("workspace_id", "created_at");

-- Webhook subscription rotation + disable reason
ALTER TABLE "webhook_subscriptions" ADD COLUMN "secret_previous" VARCHAR(64);
ALTER TABLE "webhook_subscriptions" ADD COLUMN "secret_rotated_at" TIMESTAMP(3);
ALTER TABLE "webhook_subscriptions" ADD COLUMN "disabled_reason" VARCHAR(200);

-- Durable outbound webhook delivery queue
CREATE TABLE "webhook_deliveries" (
    "id" SERIAL NOT NULL,
    "subscription_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "event_id" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "next_attempt_at" TIMESTAMP(3),
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_subscription_id_created_at_idx" ON "webhook_deliveries"("subscription_id", "created_at");
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
