-- Confluence -> Knowledge (QA 10-23 #4). Additive only: five nullable /
-- defaulted columns on knowledge_settings (instant on a live table) and a new
-- audit table for source runs. Imported articles reuse knowledge_articles
-- (source 'confluence', external_id = the page id) under the existing partial
-- unique index knowledge_articles_ws_source_external_id_key; no new index there.
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "confluence_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "confluence_auth" JSONB;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "confluence_selection" JSONB;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "confluence_state" JSONB;
ALTER TABLE "knowledge_settings" ADD COLUMN IF NOT EXISTS "confluence_synced_at" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "knowledge_source_runs" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "source" VARCHAR(30) NOT NULL DEFAULT 'confluence',
  "kind" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'running',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  "triggered_by" VARCHAR(255),
  "counts" JSONB,
  "error" TEXT,
  "model" VARCHAR(100),
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_usd" DOUBLE PRECISION
);

-- A brand-new, empty table: a plain CREATE INDEX takes no meaningful lock.
CREATE INDEX IF NOT EXISTS "idx_knowledge_source_runs_ws_source"
  ON "knowledge_source_runs" ("workspace_id", "source", "started_at");
