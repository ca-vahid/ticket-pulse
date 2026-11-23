-- Personal API keys (4.4.05). New table only; nothing existing changes.
-- A key that acts as one person in one workspace ("tpu_" prefix, sha256 hash).
CREATE TABLE IF NOT EXISTS "personal_api_keys" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "technician_id" INTEGER,
  "owner_email" VARCHAR(255) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "key_hash" VARCHAR(64) NOT NULL,
  "key_prefix" VARCHAR(24) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ip_allowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expires_at" TIMESTAMP(3) NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "disabled_at" TIMESTAMP(3),
  "disabled_by" VARCHAR(255),
  "revoked_at" TIMESTAMP(3),
  "revoked_by" VARCHAR(255),
  "revoked_reason" VARCHAR(40),
  "rotated_from_id" INTEGER,
  "expiry_warned_at" TIMESTAMP(3),
  "expired_noted_at" TIMESTAMP(3),
  "last_used_at" TIMESTAMP(3),
  "last_used_ip" VARCHAR(64),
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "personal_api_keys_key_hash_key" ON "personal_api_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "personal_api_keys_workspace_id_technician_id_idx" ON "personal_api_keys" ("workspace_id", "technician_id");
CREATE INDEX IF NOT EXISTS "personal_api_keys_workspace_id_owner_email_idx" ON "personal_api_keys" ("workspace_id", "owner_email");
CREATE INDEX IF NOT EXISTS "personal_api_keys_expires_at_idx" ON "personal_api_keys" ("expires_at");
-- One key per person per workspace: at most one unrevoked row (active, switched
-- off or ended-but-not-yet-revoked). The service checks first under an advisory
-- lock; this index is the last line. Not expressible in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "personal_api_keys_one_live_per_person" ON "personal_api_keys" ("workspace_id", lower("owner_email")) WHERE "revoked_at" IS NULL;
