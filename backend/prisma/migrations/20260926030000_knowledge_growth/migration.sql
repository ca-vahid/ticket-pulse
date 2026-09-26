SET lock_timeout = '5s';

-- Auto-help P1 "Knowledge that grows" (plans/AUTO_HELP_P1_PLAN.md section 4). Additive only.

-- FreshService solution import bookkeeping + where a drafted article came from.
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "fs_updated_at" TIMESTAMPTZ(6);
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "source_meta" JSONB;

-- Verified-solution vectors (subject + solution note; never internal notes).
CREATE TABLE IF NOT EXISTS "ticket_solution_embeddings" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "category_id" INTEGER,
  "embedding" DOUBLE PRECISION[],
  "model" VARCHAR(80) NOT NULL,
  "content_hash" VARCHAR(64) NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_solution_embeddings_ticket_id_key" ON "ticket_solution_embeddings" ("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_ticket_solution_embeddings_ws_cat" ON "ticket_solution_embeddings" ("workspace_id", "category_id");

-- Per-workspace Knowledge switches: FreshService import, weekly review digest (both off).
CREATE TABLE IF NOT EXISTS "knowledge_settings" (
  "workspace_id" INTEGER PRIMARY KEY,
  "fs_import_enabled" BOOLEAN NOT NULL DEFAULT false,
  "fs_folder_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "fs_import_state" JSONB,
  "fs_imported_at" TIMESTAMPTZ(6),
  "review_digest_enabled" BOOLEAN NOT NULL DEFAULT false,
  "review_digest_sent_at" TIMESTAMPTZ(6),
  "updated_by" VARCHAR(255),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One Knowledge article per external article (FreshService import): the
-- importer upserts against this and holds a per-workspace advisory lock, so
-- two containers / a double "Import now" can never create duplicates.
-- Partial (external_id IS NOT NULL): Ticket Pulse-authored articles have no
-- external id. Plain CREATE UNIQUE INDEX (not CONCURRENTLY, which cannot run
-- inside a migration transaction) is acceptable HERE ONLY because
-- knowledge_articles is a small table (created in 3.9.89, near-empty in
-- production; the FreshService import has never run there), so the brief
-- lock is negligible. Do not copy this pattern onto a large live table.
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_articles_ws_source_external_id_key"
  ON "knowledge_articles" ("workspace_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL;
