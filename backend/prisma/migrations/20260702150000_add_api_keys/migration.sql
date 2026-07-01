-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_hash" VARCHAR(64) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_workspace_id_is_enabled_idx" ON "api_keys"("workspace_id", "is_enabled");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

