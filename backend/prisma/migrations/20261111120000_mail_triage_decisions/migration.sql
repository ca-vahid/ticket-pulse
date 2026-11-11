-- Mail triage (plans/MAIL_TRIAGE_PLAN.md, 11 Nov 2026). Additive only: one new
-- table, nothing changed on existing ones. One row per judgement of a held
-- e-mail (and one per decision a person made with no AI suggestion, so it can
-- be undone). E-mail bodies are never copied here; they stay on the held row.
-- Kept 180 days (daily prune in apiMaintenanceService).
CREATE TABLE IF NOT EXISTS "mail_triage_decisions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "held_message_id" INTEGER NOT NULL,
  "subject" VARCHAR(300),
  "from_email" VARCHAR(255),
  "mode" VARCHAR(10) NOT NULL,
  "action" VARCHAR(12),
  "ticket_id" INTEGER,
  "reopen" BOOLEAN NOT NULL DEFAULT false,
  "requester_email" VARCHAR(255),
  "related_ticket_ids" JSONB,
  "confidence" VARCHAR(10),
  "reason" TEXT,
  "evidence" JSONB,
  "candidates" JSONB,
  "candidate_key" VARCHAR(64),
  "guards" JSONB,
  "provider" VARCHAR(30),
  "model" VARCHAR(100),
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_usd" DECIMAL(10,6),
  "latency_ms" INTEGER,
  "raw" JSONB,
  "outcome" VARCHAR(12) NOT NULL,
  "final_action" VARCHAR(12),
  "final_ticket_id" INTEGER,
  "decided_by" VARCHAR(255),
  "decided_at" TIMESTAMPTZ(6),
  "undo" JSONB,
  "error" VARCHAR(300),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "mail_triage_decisions_workspace_id_created_at_idx" ON "mail_triage_decisions" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "mail_triage_decisions_held_message_id_idx" ON "mail_triage_decisions" ("held_message_id");
