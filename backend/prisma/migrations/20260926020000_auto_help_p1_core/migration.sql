SET lock_timeout = '5s';

-- Auto-help P1 core (plans/AUTO_HELP_P1_PLAN.md sections 1-3): approve mode,
-- the follow-up loop's outcomes, metrics, readiness gate, sensitive playbooks
-- and the monthly cost cap. Additive only; every statement is re-runnable.

-- An Auto-help proposal points back at the run that drafted it.
ALTER TABLE "ticket_proposed_replies" ADD COLUMN IF NOT EXISTS "auto_help_run_id" INTEGER;

-- What the agent did with a staged answer (agent_sent | agent_edited_sent |
-- agent_dismissed | auto_sent) is kept apart from the follow-up outcome
-- (resolved_silence | resolved_confirmed | help_requested | reopened |
-- agent_took_over | no_reply_left_open): one run has both.
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "decision" VARCHAR(30);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "decided_at" TIMESTAMPTZ(6);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "decided_by" VARCHAR(255);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "edit_distance" DOUBLE PRECISION;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "dismiss_reason" VARCHAR(40);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "outcome_detail" JSONB;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "cost_usd" DOUBLE PRECISION;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "input_tokens" INTEGER;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "output_tokens" INTEGER;

-- Password / MFA / access / security playbooks: approve-only, never auto.
ALTER TABLE "auto_help_playbooks" ADD COLUMN IF NOT EXISTS "sensitive" BOOLEAN NOT NULL DEFAULT false;

-- Workspace switches: approve mode (off by default), the monthly model-cost
-- cap in USD (null = no cap) and the thank-you on a confirmed fix (off).
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "approve_mode_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "monthly_cost_cap_usd" DOUBLE PRECISION;
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "thank_on_confirm" BOOLEAN NOT NULL DEFAULT false;

-- Loop safety (P1 audit): the follow-up promise frozen at send, and the atomic
-- claims that keep the park sweep and a requester reply from both acting.
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "follow_up_plan" JSONB;
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "requester_replied_at" TIMESTAMPTZ(6);
ALTER TABLE "auto_help_runs" ADD COLUMN IF NOT EXISTS "close_claimed_at" TIMESTAMPTZ(6);

-- Spend after a run was created (reply classification), booked in the month
-- it happened so the monthly cost cap sees it.
CREATE TABLE IF NOT EXISTS "auto_help_cost_entries" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "run_id" INTEGER,
    "playbook_id" INTEGER,
    "kind" VARCHAR(30) NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auto_help_cost_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_auto_help_cost_entries_ws_created" ON "auto_help_cost_entries"("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_auto_help_cost_entries_run" ON "auto_help_cost_entries"("run_id");

-- The park sweep's stale-claim recovery reads these every minute; partial
-- indexes keep it to the handful of rows that matter (auto_help_runs is a
-- new, small table: plain CREATE INDEX is fine here).
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_reply_claim" ON "auto_help_runs" ("requester_replied_at") WHERE "outcome" IS NULL AND "requester_replied_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_close_claim" ON "auto_help_runs" ("close_claimed_at") WHERE "outcome" IS NULL AND "close_claimed_at" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_auto_help_runs_open_loops" ON "auto_help_runs" ("decided_at") WHERE "outcome" IS NULL AND "decision" IS NOT NULL;
-- tickets.parked_until is covered by the existing out-of-band partial index
-- (see backend/scripts/sql/auto-help-parked-until-index.sql — CONCURRENTLY,
-- never in a migration: tickets is a live table).

-- "Stay quiet when" (26 Sep 2026): hard-stop conditions the model is given as
-- numbered rules. Per playbook, plus a workspace-wide list seeded with three
-- defaults (keep in step with autoHelpPlaybookService.DEFAULT_ALWAYS_STAY_QUIET).
ALTER TABLE "auto_help_playbooks" ADD COLUMN IF NOT EXISTS "stay_quiet_when" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "always_stay_quiet_when" TEXT[] NOT NULL DEFAULT ARRAY[
    'Any sign of a security incident or a possibly compromised account (phishing, suspicious sign-ins, hacked, breach)',
    'The requester is complaining about IT or is frustrated with a previous answer',
    'HR, legal, or personal matters'
]::TEXT[];

-- Auto-help integration W1-W5 (plans/AUTO_HELP_INTEGRATION_PLAN.md).
-- tickets is a LIVE table: nullable columns with no default only (a
-- metadata-only change, no rewrite), and no index on tickets here.
-- W2: who owns the first reply (agent > auto_help > workflow_draft).
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "reply_owner" VARCHAR(20);
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "reply_owner_ref" VARCHAR(80);
-- W4: an automated (auto-sent) first answer, kept apart from first_public_agent_reply_at.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "first_automated_reply_at" TIMESTAMPTZ(6);
-- W4: whether an auto-sent answer stops the first-response clock (off).
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "counts_as_first_response" BOOLEAN NOT NULL DEFAULT false;

-- W5: the durable Auto-help trigger queue (new, small table).
CREATE TABLE IF NOT EXISTS "auto_help_jobs" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "trigger" VARCHAR(30) NOT NULL,
    "dedupe_key" VARCHAR(120) NOT NULL,
    "payload" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auto_help_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_auto_help_jobs_dedupe" ON "auto_help_jobs"("dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_auto_help_jobs_status_run_after" ON "auto_help_jobs"("status", "run_after");
CREATE INDEX IF NOT EXISTS "idx_auto_help_jobs_ticket" ON "auto_help_jobs"("ticket_id");

-- W3: a "Ticket arrived" ack held back to ride on the Auto-help answer (ack merge).
CREATE TABLE IF NOT EXISTS "auto_help_pending_acks" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "workflow_run_id" INTEGER,
    "node_id" VARCHAR(120),
    "ack_text" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_run_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auto_help_pending_acks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_auto_help_pending_acks_ticket_status" ON "auto_help_pending_acks"("ticket_id", "status");

-- Audit follow-ups (26 Sep 2026). Appended after the first local apply: a dev
-- DB that applied an earlier version shows a checksum mismatch (prod never
-- applied this migration). auto_help_settings is a tiny table.
-- When Auto-help was last switched on: the catch-up sweeps never look before it.
ALTER TABLE "auto_help_settings" ADD COLUMN IF NOT EXISTS "enabled_at" TIMESTAMPTZ(6);
UPDATE "auto_help_settings" SET "enabled_at" = "updated_at" WHERE "enabled" = true AND "enabled_at" IS NULL;
