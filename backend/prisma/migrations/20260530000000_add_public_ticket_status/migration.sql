CREATE TABLE "public_ticket_status_settings" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "expiry_days" INTEGER DEFAULT 60,
  "show_requester_name" BOOLEAN NOT NULL DEFAULT false,
  "show_requester_email" BOOLEAN NOT NULL DEFAULT false,
  "show_assigned_agent" BOOLEAN NOT NULL DEFAULT true,
  "show_summary" BOOLEAN NOT NULL DEFAULT true,
  "show_priority" BOOLEAN NOT NULL DEFAULT true,
  "show_category" BOOLEAN NOT NULL DEFAULT true,
  "show_workspace_stats" BOOLEAN NOT NULL DEFAULT true,
  "eta_lookback_days" INTEGER NOT NULL DEFAULT 180,
  "eta_min_sample_size" INTEGER NOT NULL DEFAULT 8,
  "eta_percentile" INTEGER NOT NULL DEFAULT 75,
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "public_ticket_status_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_ticket_status_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "public_ticket_status_settings_workspace_id_key"
  ON "public_ticket_status_settings"("workspace_id");

CREATE INDEX "public_ticket_status_settings_workspace_id_idx"
  ON "public_ticket_status_settings"("workspace_id");

CREATE TABLE "public_ticket_status_links" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "token" VARCHAR(90) NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "token_prefix" VARCHAR(12),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoked_by" VARCHAR(255),
  "created_by" VARCHAR(255),
  "last_viewed_at" TIMESTAMP(3),
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "public_ticket_status_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_ticket_status_links_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "public_ticket_status_links_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "public_ticket_status_links_token_hash_key"
  ON "public_ticket_status_links"("token_hash");

CREATE UNIQUE INDEX "public_ticket_status_links_token_key"
  ON "public_ticket_status_links"("token");

CREATE UNIQUE INDEX "public_ticket_status_links_workspace_id_ticket_id_key"
  ON "public_ticket_status_links"("workspace_id", "ticket_id");

CREATE INDEX "public_ticket_status_links_workspace_id_enabled_idx"
  ON "public_ticket_status_links"("workspace_id", "enabled");

CREATE INDEX "public_ticket_status_links_ticket_id_idx"
  ON "public_ticket_status_links"("ticket_id");

CREATE INDEX "public_ticket_status_links_expires_at_idx"
  ON "public_ticket_status_links"("expires_at");

CREATE INDEX "public_ticket_status_links_revoked_at_idx"
  ON "public_ticket_status_links"("revoked_at");

CREATE TABLE "public_ticket_status_views" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "link_id" INTEGER NOT NULL,
  "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_hash" VARCHAR(64),
  "user_agent" VARCHAR(500),
  "status_at_view" VARCHAR(50),
  "payload" JSONB,

  CONSTRAINT "public_ticket_status_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_ticket_status_views_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "public_ticket_status_views_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "public_ticket_status_views_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "public_ticket_status_links"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "public_ticket_status_views_workspace_id_viewed_at_idx"
  ON "public_ticket_status_views"("workspace_id", "viewed_at");

CREATE INDEX "public_ticket_status_views_ticket_id_viewed_at_idx"
  ON "public_ticket_status_views"("ticket_id", "viewed_at");

CREATE INDEX "public_ticket_status_views_link_id_viewed_at_idx"
  ON "public_ticket_status_views"("link_id", "viewed_at");
