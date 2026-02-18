-- Add columns that were in schema.prisma but missing from prior migrations

-- Technician columns
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "workspace_id" BIGINT;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "photo_url" TEXT;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "photo_synced_at" TIMESTAMPTZ;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "show_on_map" BOOLEAN DEFAULT true;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "is_map_manager" BOOLEAN DEFAULT false;

-- Technician indexes
CREATE INDEX IF NOT EXISTS "technicians_workspace_id_idx" ON "technicians" ("workspace_id");
CREATE INDEX IF NOT EXISTS "technicians_email_idx" ON "technicians" ("email");

-- Session table for connect-pg-simple (Express session store)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
