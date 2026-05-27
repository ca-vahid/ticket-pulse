-- AI provider settings, attempt audit, and health history.
CREATE TABLE IF NOT EXISTS "ai_provider_settings" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "operation" VARCHAR(60) NOT NULL,
  "primary_provider" VARCHAR(30) NOT NULL DEFAULT 'anthropic',
  "primary_model" VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-6',
  "fallback_provider" VARCHAR(30) DEFAULT 'openai',
  "fallback_model" VARCHAR(100) DEFAULT 'gpt-5.1',
  "auto_fallback_enabled" BOOLEAN NOT NULL DEFAULT true,
  "fallback_mode" VARCHAR(40) NOT NULL DEFAULT 'retry_safe_checkpoint',
  "last_changed_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_provider_settings_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_settings_workspace_id_operation_key"
  ON "ai_provider_settings"("workspace_id", "operation");
CREATE INDEX IF NOT EXISTS "ai_provider_settings_workspace_id_idx" ON "ai_provider_settings"("workspace_id");
CREATE INDEX IF NOT EXISTS "ai_provider_settings_operation_idx" ON "ai_provider_settings"("operation");

CREATE TABLE IF NOT EXISTS "ai_provider_attempts" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "operation" VARCHAR(60) NOT NULL,
  "provider" VARCHAR(30) NOT NULL,
  "model" VARCHAR(100) NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'running',
  "fallback_from_provider" VARCHAR(30),
  "fallback_reason" TEXT,
  "error_class" VARCHAR(50),
  "error_message" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "duration_ms" INTEGER,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "raw_metadata" JSONB,
  "assignment_pipeline_run_id" INTEGER,
  "competency_analysis_run_id" INTEGER,
  "assignment_daily_review_run_id" INTEGER,
  "daily_review_consolidation_run_id" INTEGER,
  "ticket_reclassification_run_id" INTEGER,
  CONSTRAINT "ai_provider_attempts_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_attempts_assignment_pipeline_run_id_fkey"
    FOREIGN KEY ("assignment_pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_attempts_competency_analysis_run_id_fkey"
    FOREIGN KEY ("competency_analysis_run_id") REFERENCES "competency_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_attempts_assignment_daily_review_run_id_fkey"
    FOREIGN KEY ("assignment_daily_review_run_id") REFERENCES "assignment_daily_review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_attempts_daily_review_consolidation_run_id_fkey"
    FOREIGN KEY ("daily_review_consolidation_run_id") REFERENCES "assignment_daily_review_consolidation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_provider_attempts_ticket_reclassification_run_id_fkey"
    FOREIGN KEY ("ticket_reclassification_run_id") REFERENCES "ticket_reclassification_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ai_provider_attempts_workspace_id_operation_started_at_idx"
  ON "ai_provider_attempts"("workspace_id", "operation", "started_at");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_provider_started_at_idx"
  ON "ai_provider_attempts"("provider", "started_at");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_status_idx" ON "ai_provider_attempts"("status");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_assignment_pipeline_run_id_idx" ON "ai_provider_attempts"("assignment_pipeline_run_id");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_competency_analysis_run_id_idx" ON "ai_provider_attempts"("competency_analysis_run_id");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_assignment_daily_review_run_id_idx" ON "ai_provider_attempts"("assignment_daily_review_run_id");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_daily_review_consolidation_run_id_idx" ON "ai_provider_attempts"("daily_review_consolidation_run_id");
CREATE INDEX IF NOT EXISTS "ai_provider_attempts_ticket_reclassification_run_id_idx" ON "ai_provider_attempts"("ticket_reclassification_run_id");

CREATE TABLE IF NOT EXISTS "ai_provider_health_events" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER,
  "operation" VARCHAR(60),
  "provider" VARCHAR(30) NOT NULL,
  "model" VARCHAR(100),
  "success" BOOLEAN NOT NULL,
  "error_class" VARCHAR(50),
  "status_code" INTEGER,
  "duration_ms" INTEGER,
  "sanitized_message" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_provider_health_events_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ai_provider_health_events_provider_created_at_idx"
  ON "ai_provider_health_events"("provider", "created_at");
CREATE INDEX IF NOT EXISTS "ai_provider_health_events_workspace_id_operation_created_at_idx"
  ON "ai_provider_health_events"("workspace_id", "operation", "created_at");
CREATE INDEX IF NOT EXISTS "ai_provider_health_events_success_created_at_idx"
  ON "ai_provider_health_events"("success", "created_at");

ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "llm_provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "llm_fallback_used" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "llm_fallback_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "llm_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "competency_analysis_runs"
  ADD COLUMN IF NOT EXISTS "llm_provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "llm_fallback_used" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "llm_fallback_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "llm_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "assignment_daily_review_runs"
  ADD COLUMN IF NOT EXISTS "llm_provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "llm_fallback_used" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "llm_fallback_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "llm_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "assignment_daily_review_consolidation_runs"
  ADD COLUMN IF NOT EXISTS "llm_provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "llm_fallback_used" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "llm_fallback_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "llm_attempt_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ticket_reclassification_runs"
  ADD COLUMN IF NOT EXISTS "llm_provider" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "llm_model" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "llm_fallback_used" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "llm_fallback_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "llm_attempt_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "assignment_pipeline_runs"
SET "llm_provider" = CASE
  WHEN "llm_model" ILIKE 'claude-%' THEN 'anthropic'
  WHEN "llm_model" ILIKE 'gpt-%' OR "llm_model" ILIKE 'o1%' OR "llm_model" ILIKE 'o3%' OR "llm_model" ILIKE 'o4-%' THEN 'openai'
  ELSE COALESCE("llm_provider", 'anthropic')
END
WHERE "llm_provider" IS NULL;

UPDATE "competency_analysis_runs"
SET "llm_provider" = CASE
  WHEN "llm_model" ILIKE 'claude-%' THEN 'anthropic'
  WHEN "llm_model" ILIKE 'gpt-%' OR "llm_model" ILIKE 'o1%' OR "llm_model" ILIKE 'o3%' OR "llm_model" ILIKE 'o4-%' THEN 'openai'
  ELSE COALESCE("llm_provider", 'anthropic')
END
WHERE "llm_provider" IS NULL;

UPDATE "assignment_daily_review_runs"
SET "llm_provider" = CASE
  WHEN "llm_model" ILIKE 'claude-%' THEN 'anthropic'
  WHEN "llm_model" ILIKE 'gpt-%' OR "llm_model" ILIKE 'o1%' OR "llm_model" ILIKE 'o3%' OR "llm_model" ILIKE 'o4-%' THEN 'openai'
  ELSE COALESCE("llm_provider", 'anthropic')
END
WHERE "llm_provider" IS NULL;

UPDATE "assignment_daily_review_consolidation_runs"
SET "llm_provider" = CASE
  WHEN "llm_model" ILIKE 'claude-%' THEN 'anthropic'
  WHEN "llm_model" ILIKE 'gpt-%' OR "llm_model" ILIKE 'o1%' OR "llm_model" ILIKE 'o3%' OR "llm_model" ILIKE 'o4-%' THEN 'openai'
  ELSE COALESCE("llm_provider", 'anthropic')
END
WHERE "llm_provider" IS NULL;

INSERT INTO "ai_provider_settings" (
  "workspace_id",
  "operation",
  "primary_provider",
  "primary_model",
  "fallback_provider",
  "fallback_model",
  "auto_fallback_enabled",
  "fallback_mode",
  "created_at",
  "updated_at"
)
SELECT
  w."id",
  op.operation,
  CASE
    WHEN op.operation IN ('autoresponse_classification', 'autoresponse_generation') THEN
      CASE
        WHEN COALESCE(lc."model", 'gpt-5.1') ILIKE 'claude-%' THEN 'anthropic'
        ELSE 'openai'
      END
    WHEN COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'gpt-%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o1%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o3%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o4-%'
      THEN 'openai'
    ELSE 'anthropic'
  END,
  CASE
    WHEN op.operation IN ('autoresponse_classification', 'autoresponse_generation') THEN COALESCE(lc."model", 'gpt-5.1')
    ELSE COALESCE(ac."llm_model", 'claude-sonnet-4-6')
  END,
  CASE
    WHEN op.operation IN ('autoresponse_classification', 'autoresponse_generation') THEN
      CASE WHEN COALESCE(lc."model", 'gpt-5.1') ILIKE 'claude-%' THEN 'openai' ELSE 'anthropic' END
    WHEN COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'gpt-%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o1%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o3%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o4-%'
      THEN 'anthropic'
    ELSE 'openai'
  END,
  CASE
    WHEN op.operation IN ('autoresponse_classification', 'autoresponse_generation') THEN
      CASE WHEN COALESCE(lc."model", 'gpt-5.1') ILIKE 'claude-%' THEN 'gpt-5.1' ELSE 'claude-sonnet-4-6' END
    WHEN COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'gpt-%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o1%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o3%'
      OR COALESCE(ac."llm_model", 'claude-sonnet-4-6') ILIKE 'o4-%'
      THEN 'claude-sonnet-4-6'
    ELSE 'gpt-5.1'
  END,
  true,
  'retry_safe_checkpoint',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workspaces" w
LEFT JOIN "assignment_configs" ac ON ac."workspace_id" = w."id"
LEFT JOIN LATERAL (
  SELECT "model"
  FROM "llm_configs"
  WHERE "workspace_id" = w."id" AND "status" = 'published'
  ORDER BY "version" DESC
  LIMIT 1
) lc ON true
CROSS JOIN (
  VALUES
    ('assignment_pipeline'),
    ('competency_analysis'),
    ('daily_review'),
    ('daily_review_consolidation'),
    ('ticket_reclassification'),
    ('calendar_leave'),
    ('autoresponse_classification'),
    ('autoresponse_generation')
) AS op(operation)
ON CONFLICT ("workspace_id", "operation") DO NOTHING;
