-- Read limits per OAuth client (Simorgh IT read-search, 6 Nov 2026).
-- Additive; the defaults keep every existing client's reads unchanged.
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "read_exclude_category_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "read_private_notes" BOOLEAN NOT NULL DEFAULT true;
