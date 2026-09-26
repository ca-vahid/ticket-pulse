-- Fail fast instead of queueing behind live traffic on tickets/technicians (additive, metadata-only ALTERs).
SET lock_timeout = '5s';

-- QA 09-25: re-opened, hand-back reasons, tone, assignable-only, team forwards, Knowledge + Auto-help. Additive only.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "reopened_at" TIMESTAMPTZ(6);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "reopen_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "assignable_only" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "ticket_hand_backs" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "technician_id" INTEGER,
  "actor_tech_id" INTEGER,
  "actor_name" VARCHAR(255),
  "self_hand_back" BOOLEAN NOT NULL DEFAULT true,
  "reason_code" VARCHAR(30),
  "reason_note" TEXT,
  "origin" VARCHAR(20) NOT NULL,
  "episode_id" INTEGER,
  "pipeline_run_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_hand_backs_ws_created" ON "ticket_hand_backs" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_hand_backs_ticket" ON "ticket_hand_backs" ("ticket_id");

CREATE TABLE IF NOT EXISTS "tone_settings" (
  "workspace_id" INTEGER PRIMARY KEY,
  "default_voice" VARCHAR(20) NOT NULL DEFAULT 'friendly',
  "serious_tone_text" TEXT,
  "serious_when_frustrated" BOOLEAN NOT NULL DEFAULT true,
  "updated_by" VARCHAR(255),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "tone_override_contacts" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "name" VARCHAR(255),
  "requester_id" INTEGER,
  "note" TEXT,
  "added_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tone_contacts_ws_email" ON "tone_override_contacts" ("workspace_id", "email");

CREATE TABLE IF NOT EXISTS "team_forwards" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "email" VARCHAR(255),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_team_forwards_ws" ON "team_forwards" ("workspace_id");

CREATE TABLE IF NOT EXISTS "knowledge_articles" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "source" VARCHAR(20) NOT NULL DEFAULT 'tp',
  "external_id" VARCHAR(100),
  "title" VARCHAR(300) NOT NULL,
  "body_html" TEXT NOT NULL DEFAULT '',
  "body_text" TEXT NOT NULL DEFAULT '',
  "category_id" INTEGER,
  "subcategory_id" INTEGER,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  "content_hash" VARCHAR(64),
  "created_by" VARCHAR(255),
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_knowledge_articles_ws_status" ON "knowledge_articles" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "auto_help_playbooks" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "mode" VARCHAR(20) NOT NULL DEFAULT 'shadow',
  "category_id" INTEGER,
  "subcategory_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "match" JSONB,
  "instructions" TEXT NOT NULL DEFAULT '',
  "allowed_tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "kb_scope" JSONB,
  "min_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  "follow_up" JSONB,
  "on_help" VARCHAR(40) NOT NULL DEFAULT 'assign_normally',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(255),
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_auto_help_playbooks_ws" ON "auto_help_playbooks" ("workspace_id", "enabled");

CREATE TABLE IF NOT EXISTS "auto_help_runs" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "playbook_id" INTEGER,
  "playbook_version" INTEGER,
  "mode" VARCHAR(20) NOT NULL,
  "trigger" VARCHAR(20) NOT NULL DEFAULT 'categorized',
  "status" VARCHAR(20) NOT NULL,
  "confidence" DOUBLE PRECISION,
  "draft_subject" VARCHAR(300),
  "draft_html" TEXT,
  "draft_text" TEXT,
  "sources" JSONB,
  "transcript" JSONB,
  "gate_decision" VARCHAR(60),
  "proposed_reply_id" INTEGER,
  "sent_entry_id" INTEGER,
  "nudged_at" TIMESTAMPTZ(6),
  "outcome" VARCHAR(30),
  "outcome_at" TIMESTAMPTZ(6),
  "error" TEXT,
  "duration_ms" INTEGER,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_ws_created" ON "auto_help_runs" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_ticket" ON "auto_help_runs" ("ticket_id");

CREATE TABLE IF NOT EXISTS "auto_help_settings" (
  "workspace_id" INTEGER PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "disclosure_enabled" BOOLEAN NOT NULL DEFAULT true,
  "disclosure_text" TEXT,
  "updated_by" VARCHAR(255),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Auto-help audit fixes (25 Sep 2026): explicit "instructions are a source" opt-in,
-- requester on runs (daily cap), skip rows + stale-run sweep lookups.
ALTER TABLE "auto_help_playbooks" ADD COLUMN IF NOT EXISTS "instructions_are_source" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "requester_id" INTEGER;
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_requester" ON "auto_help_runs" ("workspace_id", "requester_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_status_created" ON "auto_help_runs" ("status", "created_at");

-- Auto-help research requirements (25 Sep 2026): article governance (R1), section
-- chunks (R2), answerability checks (R4), shadow review verdicts (R6).
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "owner_email" VARCHAR(255);
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "last_verified_at" TIMESTAMPTZ(6);
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "review_every_days" INTEGER NOT NULL DEFAULT 180;
ALTER TABLE "knowledge_articles" ADD COLUMN IF NOT EXISTS "sections" JSONB;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "checks" JSONB;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "review_verdict" VARCHAR(30);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "review_note" TEXT;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "reviewed_by" VARCHAR(255);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(6);
