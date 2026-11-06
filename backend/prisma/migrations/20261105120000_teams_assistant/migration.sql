-- Teams assistant (plans/TEAMS_BOT_COMMANDS_PLAN.md, 5 Nov 2026). Additive only:
-- three new tables, nothing changed on existing ones. The assistant settings
-- live in their own table (not new columns on notification_workspace_settings)
-- so a client generated before this migration is applied can never break the
-- Teams notification reads.

-- Per workspace: Off | Shadow | Pilot | On, the pilot people, the monthly AI
-- cap and the "keep subjects away from the AI" switch.
CREATE TABLE IF NOT EXISTS "teams_assistant_settings" (
  "workspace_id" INTEGER PRIMARY KEY,
  "mode" VARCHAR(10) NOT NULL DEFAULT 'off',
  "pilot_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "monthly_cap_usd" DECIMAL(8,2) NOT NULL DEFAULT 25,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "cap_alerted_month" VARCHAR(7),
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per person: "Ask Ticket Pulse in Teams (advanced)". No row = on.
CREATE TABLE IF NOT EXISTS "teams_assistant_people" (
  "email" VARCHAR(255) PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per message the assistant handled. Kept 180 days (daily prune in
-- apiMaintenanceService). Never stores tool output, only names, counts and ids.
CREATE TABLE IF NOT EXISTS "teams_assistant_turns" (
  "id" SERIAL PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL,
  "workspace_id" INTEGER,
  "conversation_id" VARCHAR(255),
  "activity_id" VARCHAR(255),
  "mode" VARCHAR(10) NOT NULL,
  "route" VARCHAR(20) NOT NULL,
  "question" VARCHAR(500) NOT NULL,
  "tool_calls" JSONB,
  "answer_kind" VARCHAR(20),
  "shown_ids" JSONB,
  "lead" VARCHAR(300),
  "reply_summary" VARCHAR(300),
  "delivered" VARCHAR(20),
  "provider" VARCHAR(30),
  "model" VARCHAR(100),
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "cost_usd" DECIMAL(10,6),
  "latency_ms" INTEGER,
  "outcome" VARCHAR(20) NOT NULL,
  "error" VARCHAR(200),
  "feedback" VARCHAR(20),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "teams_assistant_turns_email_created_at_idx" ON "teams_assistant_turns"("email", "created_at");
CREATE INDEX IF NOT EXISTS "teams_assistant_turns_conversation_id_created_at_idx" ON "teams_assistant_turns"("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "teams_assistant_turns_workspace_id_created_at_idx" ON "teams_assistant_turns"("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "teams_assistant_turns_created_at_idx" ON "teams_assistant_turns"("created_at");

-- Defaults (Vahid, 5 Nov 2026): every workspace Off except IT (workspace 1)
-- in Shadow, with the time-away approval managers on its pilot list. Ids only
-- here (the repository is public): technicians 20 and 59 are the approvers of
-- the active availability approval group, read from production on 5 Nov.
-- Pilot only matters once IT is switched to Pilot; in Shadow nobody gets an
-- AI answer.
INSERT INTO "teams_assistant_settings" ("workspace_id", "mode", "pilot_emails", "updated_by")
SELECT 1, 'shadow',
  COALESCE(ARRAY(
    SELECT DISTINCT lower("email") FROM "technicians"
    WHERE "id" IN (20, 59) AND "workspace_id" = 1 AND "is_active" = true AND "email" IS NOT NULL
  ), ARRAY[]::TEXT[]),
  'migration 20261105120000'
WHERE EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = 1)
ON CONFLICT ("workspace_id") DO NOTHING;
