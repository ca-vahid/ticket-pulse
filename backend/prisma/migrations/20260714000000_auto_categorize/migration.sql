-- Auto-categorize: write AI categories to FreshService on pending_review /
-- priority_only runs while assignment stays human-gated. Additive.
ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "auto_categorize_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "category_writeback_status" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "category_writeback_payload" JSONB,
  ADD COLUMN IF NOT EXISTS "category_writeback_error" TEXT,
  ADD COLUMN IF NOT EXISTS "category_written_at" TIMESTAMP(3);
