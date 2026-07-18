-- Built-in OAuth2 client-credentials apps (workspace-scoped).
CREATE TABLE "oauth_clients" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "client_id" VARCHAR(40) NOT NULL,
    "client_secret_hash" VARCHAR(64) NOT NULL,
    "secret_prefix" VARCHAR(16) NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_used_ip" VARCHAR(64),
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");
CREATE INDEX "oauth_clients_workspace_id_is_enabled_idx" ON "oauth_clients"("workspace_id", "is_enabled");
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
