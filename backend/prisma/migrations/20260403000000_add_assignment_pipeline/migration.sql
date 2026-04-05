-- Assignment Pipeline: per-workspace config, competencies, pipeline runs & steps

-- AssignmentConfig (one per workspace)
CREATE TABLE "assignment_configs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_assign" BOOLEAN NOT NULL DEFAULT false,
    "llm_model" VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-6-20260217',
    "max_recommendations" INTEGER NOT NULL DEFAULT 3,
    "scoring_weights" JSONB,
    "classification_prompt" TEXT,
    "categorization_prompt" TEXT,
    "recommendation_prompt" TEXT,
    "feedback_context" TEXT,
    "poll_for_unassigned" BOOLEAN NOT NULL DEFAULT true,
    "poll_max_per_cycle" INTEGER NOT NULL DEFAULT 5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assignment_configs_workspace_id_key" ON "assignment_configs"("workspace_id");

ALTER TABLE "assignment_configs"
    ADD CONSTRAINT "assignment_configs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CompetencyCategory (workspace-scoped skill categories)
CREATE TABLE "competency_categories" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competency_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "competency_categories_workspace_id_name_key" ON "competency_categories"("workspace_id", "name");
CREATE INDEX "competency_categories_workspace_id_idx" ON "competency_categories"("workspace_id");

ALTER TABLE "competency_categories"
    ADD CONSTRAINT "competency_categories_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- TechnicianCompetency (maps techs to skills with proficiency)
CREATE TABLE "technician_competencies" (
    "id" SERIAL NOT NULL,
    "technician_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "competency_category_id" INTEGER NOT NULL,
    "proficiency_level" VARCHAR(20) NOT NULL DEFAULT 'intermediate',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "technician_competencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "technician_competencies_technician_id_competency_category_id_key" ON "technician_competencies"("technician_id", "competency_category_id");
CREATE INDEX "technician_competencies_workspace_id_idx" ON "technician_competencies"("workspace_id");
CREATE INDEX "technician_competencies_technician_id_idx" ON "technician_competencies"("technician_id");
CREATE INDEX "technician_competencies_competency_category_id_idx" ON "technician_competencies"("competency_category_id");

ALTER TABLE "technician_competencies"
    ADD CONSTRAINT "technician_competencies_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "technician_competencies"
    ADD CONSTRAINT "technician_competencies_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "technician_competencies"
    ADD CONSTRAINT "technician_competencies_competency_category_id_fkey"
    FOREIGN KEY ("competency_category_id") REFERENCES "competency_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AssignmentPipelineRun (one per ticket analysis)
CREATE TABLE "assignment_pipeline_runs" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "trigger_source" VARCHAR(20) NOT NULL,
    "llm_model" VARCHAR(100) NOT NULL,
    "total_duration_ms" INTEGER,
    "total_tokens_used" INTEGER,
    "recommendation" JSONB,
    "decision" VARCHAR(20) NOT NULL DEFAULT 'pending_review',
    "decided_by_email" VARCHAR(255),
    "decided_at" TIMESTAMP(3),
    "assigned_tech_id" INTEGER,
    "override_reason" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_pipeline_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assignment_pipeline_runs_ticket_id_idx" ON "assignment_pipeline_runs"("ticket_id");
CREATE INDEX "assignment_pipeline_runs_workspace_id_idx" ON "assignment_pipeline_runs"("workspace_id");
CREATE INDEX "assignment_pipeline_runs_status_idx" ON "assignment_pipeline_runs"("status");
CREATE INDEX "assignment_pipeline_runs_decision_idx" ON "assignment_pipeline_runs"("decision");
CREATE INDEX "assignment_pipeline_runs_created_at_idx" ON "assignment_pipeline_runs"("created_at");

ALTER TABLE "assignment_pipeline_runs"
    ADD CONSTRAINT "assignment_pipeline_runs_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_pipeline_runs"
    ADD CONSTRAINT "assignment_pipeline_runs_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_pipeline_runs"
    ADD CONSTRAINT "assignment_pipeline_runs_assigned_tech_id_fkey"
    FOREIGN KEY ("assigned_tech_id") REFERENCES "technicians"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AssignmentPipelineStep (individual step logs)
CREATE TABLE "assignment_pipeline_steps" (
    "id" SERIAL NOT NULL,
    "pipeline_run_id" INTEGER NOT NULL,
    "step_number" INTEGER NOT NULL,
    "step_name" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "duration_ms" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "llm_prompt" TEXT,
    "llm_response" TEXT,
    "tokens_used" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_pipeline_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assignment_pipeline_steps_pipeline_run_id_idx" ON "assignment_pipeline_steps"("pipeline_run_id");
CREATE INDEX "assignment_pipeline_steps_step_name_idx" ON "assignment_pipeline_steps"("step_name");

ALTER TABLE "assignment_pipeline_steps"
    ADD CONSTRAINT "assignment_pipeline_steps_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add pipeline_run_id to existing ticket_assignments
ALTER TABLE "ticket_assignments" ADD COLUMN "pipeline_run_id" INTEGER;
CREATE INDEX "ticket_assignments_pipeline_run_id_idx" ON "ticket_assignments"("pipeline_run_id");

ALTER TABLE "ticket_assignments"
    ADD CONSTRAINT "ticket_assignments_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "assignment_pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
