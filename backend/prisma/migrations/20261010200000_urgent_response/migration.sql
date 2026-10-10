-- Urgent response (plans/URGENT_RESPONSE_PLAN.md, QA 10-09 #5): an Urgent ticket
-- always has an owner who is at work, and somebody touches it within N minutes.
-- Additive only: new tables, nothing dropped or renamed, no foreign keys.
-- Ships disabled (mode 'off' per workspace; no settings row = off); the last
-- statement puts IT (workspace 1) in Shadow ('observe') when it has no row yet.

CREATE TABLE IF NOT EXISTS "urgent_response_settings" (
  "workspace_id" INTEGER NOT NULL,
  "mode" VARCHAR(10) NOT NULL DEFAULT 'off',
  "assign_enabled" BOOLEAN NOT NULL DEFAULT true,
  "assign_priorities" INTEGER[] NOT NULL DEFAULT ARRAY[4, 3]::INTEGER[],
  "assign_grace_minutes" INTEGER NOT NULL DEFAULT 30,
  "raise_enabled" BOOLEAN NOT NULL DEFAULT true,
  "raise_priorities" INTEGER[] NOT NULL DEFAULT ARRAY[4]::INTEGER[],
  "raise_manual_action" VARCHAR(10) NOT NULL DEFAULT 'notify',
  "clock_enabled" BOOLEAN NOT NULL DEFAULT true,
  "clock_priorities" INTEGER[] NOT NULL DEFAULT ARRAY[4]::INTEGER[],
  "clock_notify_minutes" INTEGER NOT NULL DEFAULT 15,
  "clock_move_minutes" INTEGER NOT NULL DEFAULT 30,
  "notify_audience" VARCHAR(12) NOT NULL DEFAULT 'on_shift',
  "notify_technician_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "notify_channels" TEXT[] NOT NULL DEFAULT ARRAY['teams', 'email']::TEXT[],
  "nobody_mode" VARCHAR(10) NOT NULL DEFAULT 'hold',
  "nobody_contact_technician_id" INTEGER,
  "coordinator_technician_id" INTEGER,
  "max_moves" INTEGER NOT NULL DEFAULT 2,
  "on_call_order" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "on_call_handover_day" INTEGER NOT NULL DEFAULT 1,
  "on_call_handover_time" VARCHAR(5) NOT NULL DEFAULT '17:00',
  "on_call_anchor_date" DATE,
  "baselined_at" TIMESTAMPTZ(6),
  "updated_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_response_settings_pkey" PRIMARY KEY ("workspace_id")
);

CREATE TABLE IF NOT EXISTS "urgent_response_settings_changes" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "changed_by" VARCHAR(255),
  "changed_by_name" VARCHAR(255),
  "field" VARCHAR(200) NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_response_settings_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_urgent_response_settings_changes_ws" ON "urgent_response_settings_changes" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "urgent_response_actions" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER,
  "layer" VARCHAR(12) NOT NULL,
  "action" VARCHAR(24) NOT NULL,
  "shadow" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER,
  "from_technician_id" INTEGER,
  "to_technician_id" INTEGER,
  "from_name" VARCHAR(255),
  "to_name" VARCHAR(255),
  "sentence" TEXT,
  "details" JSONB,
  "dedupe_key" VARCHAR(200),
  "undone_at" TIMESTAMPTZ(6),
  "undone_by" VARCHAR(255),
  "undo_of_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_response_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_urgent_response_actions_dedupe" ON "urgent_response_actions" ("dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_urgent_response_actions_ws" ON "urgent_response_actions" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_urgent_response_actions_ticket" ON "urgent_response_actions" ("ticket_id", "created_at");

CREATE TABLE IF NOT EXISTS "urgent_response_clocks" (
  "ticket_id" INTEGER NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "owner_technician_id" INTEGER,
  "state" VARCHAR(12) NOT NULL,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notify_at" TIMESTAMPTZ(6),
  "move_at" TIMESTAMPTZ(6),
  "notified_at" TIMESTAMPTZ(6),
  "move_count" INTEGER NOT NULL DEFAULT 0,
  "chain_technician_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "stopped_at" TIMESTAMPTZ(6),
  "stop_reason" VARCHAR(24),
  "shadow" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_response_clocks_pkey" PRIMARY KEY ("ticket_id")
);
CREATE INDEX IF NOT EXISTS "idx_urgent_response_clocks_ws_state" ON "urgent_response_clocks" ("workspace_id", "state");

CREATE TABLE IF NOT EXISTS "urgent_response_on_call_covers" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "original_technician_id" INTEGER NOT NULL,
  "cover_technician_id" INTEGER NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "note" TEXT,
  "source" VARCHAR(10) NOT NULL DEFAULT 'admin',
  "request_id" INTEGER,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelled_at" TIMESTAMPTZ(6),
  CONSTRAINT "urgent_response_on_call_covers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_urgent_response_on_call_covers_ws" ON "urgent_response_on_call_covers" ("workspace_id", "starts_at");

CREATE TABLE IF NOT EXISTS "urgent_response_cover_requests" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "original_technician_id" INTEGER NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "ends_at" TIMESTAMPTZ(6) NOT NULL,
  "message" TEXT,
  "status" VARCHAR(10) NOT NULL DEFAULT 'open',
  "asked_technician_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "responses" JSONB NOT NULL DEFAULT '[]',
  "filled_by_technician_id" INTEGER,
  "filled_at" TIMESTAMPTZ(6),
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "urgent_response_cover_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_urgent_response_cover_requests_ws_status" ON "urgent_response_cover_requests" ("workspace_id", "status");

-- IT starts in Shadow: everything is worked out and logged, nothing is sent
-- and nothing moves. Only when workspace 1 exists and has no row yet.
INSERT INTO "urgent_response_settings" ("workspace_id", "mode")
SELECT 1, 'observe'
WHERE EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = 1)
ON CONFLICT ("workspace_id") DO NOTHING;
