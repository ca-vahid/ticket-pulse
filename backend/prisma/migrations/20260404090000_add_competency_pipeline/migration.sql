-- Competency Pipeline: prompt versions, analysis runs, analysis steps

CREATE TABLE IF NOT EXISTS "competency_prompt_versions" (
    "id" SERIAL PRIMARY KEY,
    "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id"),
    "version" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "system_prompt" TEXT NOT NULL,
    "tool_config" JSONB,
    "created_by" VARCHAR(255),
    "published_by" VARCHAR(255),
    "published_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE("workspace_id", "version")
);

CREATE INDEX IF NOT EXISTS "competency_prompt_versions_workspace_id_idx" ON "competency_prompt_versions"("workspace_id");
CREATE INDEX IF NOT EXISTS "competency_prompt_versions_status_idx" ON "competency_prompt_versions"("status");

CREATE TABLE IF NOT EXISTS "competency_analysis_runs" (
    "id" SERIAL PRIMARY KEY,
    "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id"),
    "technician_id" INTEGER NOT NULL REFERENCES "technicians"("id"),
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "decision" VARCHAR(20),
    "prompt_version_id" INTEGER REFERENCES "competency_prompt_versions"("id"),
    "llm_model" VARCHAR(100),
    "full_transcript" TEXT,
    "structured_result" JSONB,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "error_message" TEXT,
    "total_tokens_used" INTEGER,
    "total_duration_ms" INTEGER,
    "triggered_by" VARCHAR(255),
    "rolled_back_by" VARCHAR(255),
    "rolled_back_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "competency_analysis_runs_workspace_id_idx" ON "competency_analysis_runs"("workspace_id");
CREATE INDEX IF NOT EXISTS "competency_analysis_runs_technician_id_idx" ON "competency_analysis_runs"("technician_id");
CREATE INDEX IF NOT EXISTS "competency_analysis_runs_status_idx" ON "competency_analysis_runs"("status");
CREATE INDEX IF NOT EXISTS "competency_analysis_runs_created_at_idx" ON "competency_analysis_runs"("created_at");

CREATE TABLE IF NOT EXISTS "competency_analysis_steps" (
    "id" SERIAL PRIMARY KEY,
    "run_id" INTEGER NOT NULL REFERENCES "competency_analysis_runs"("id") ON DELETE CASCADE,
    "step_number" INTEGER NOT NULL,
    "step_name" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "duration_ms" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "llm_response" TEXT,
    "tokens_used" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "competency_analysis_steps_run_id_idx" ON "competency_analysis_steps"("run_id");
CREATE INDEX IF NOT EXISTS "competency_analysis_steps_step_name_idx" ON "competency_analysis_steps"("step_name");
