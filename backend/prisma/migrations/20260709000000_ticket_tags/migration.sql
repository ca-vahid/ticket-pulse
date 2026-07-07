-- Tags (gap plan Phase 1): TP-owned tag layer for tickets of both origins.

CREATE TABLE IF NOT EXISTS "ticket_tags" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "color" VARCHAR(20) NOT NULL DEFAULT 'slate',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_tags_workspace_id_name_key" ON "ticket_tags"("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "ticket_tags_workspace_id_is_active_idx" ON "ticket_tags"("workspace_id", "is_active");

DO $$ BEGIN
    ALTER TABLE "ticket_tags"
        ADD CONSTRAINT "ticket_tags_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ticket_tag_links" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "tag_id" INTEGER NOT NULL,
    "created_by" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_tag_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ticket_tag_links_ticket_id_tag_id_key" ON "ticket_tag_links"("ticket_id", "tag_id");
CREATE INDEX IF NOT EXISTS "ticket_tag_links_tag_id_idx" ON "ticket_tag_links"("tag_id");

DO $$ BEGIN
    ALTER TABLE "ticket_tag_links"
        ADD CONSTRAINT "ticket_tag_links_ticket_id_fkey"
        FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ticket_tag_links"
        ADD CONSTRAINT "ticket_tag_links_tag_id_fkey"
        FOREIGN KEY ("tag_id") REFERENCES "ticket_tags"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
