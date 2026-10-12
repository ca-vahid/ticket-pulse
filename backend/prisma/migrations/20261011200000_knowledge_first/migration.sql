-- Knowledge-first answering (plans/KNOWLEDGE_SIMPLIFY_PLAN.md, phase 1).
-- Additive only. Apply to production BEFORE the merge (the deploy pipeline
-- never runs migrations): the regenerated client reads the new columns.

-- The workspace switch for the new order (off = today's playbook-gated order).
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "knowledge_first" BOOLEAN NOT NULL DEFAULT false;

-- One "everything else" rule per workspace, and playbooks over several categories.
ALTER TABLE "auto_help_playbooks" ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auto_help_playbooks" ADD COLUMN IF NOT EXISTS "category_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- What a run answered and how sure it was (evidence per category, calibration).
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "category_id" INTEGER;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "subcategory_id" INTEGER;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "confidence_band" VARCHAR(10);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "evidence" JSONB;
-- A small table (a few thousand rows): a plain index build takes milliseconds.
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_ws_category" ON "auto_help_runs" ("workspace_id", "category_id", "created_at");

-- The dial: what Auto-help may do with an answer, per category, by day and by
-- night. category_id 0 = the workspace default; a NULL field inherits
-- (subcategory -> category -> default -> built-in "draft").
CREATE TABLE IF NOT EXISTS "knowledge_category_policies" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "category_id" INTEGER NOT NULL DEFAULT 0,
  "day_level" VARCHAR(10),
  "night_level" VARCHAR(10),
  "bar" DOUBLE PRECISION,
  "always_checked" BOOLEAN,
  "notes" TEXT,
  "stay_quiet_when" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_knowledge_category_policies_ws_category" ON "knowledge_category_policies" ("workspace_id", "category_id");
