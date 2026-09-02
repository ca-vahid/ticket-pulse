-- MEGA 09-02 Phase AF2: Autofill v2 run persistence.
-- ai_provider_attempts only keeps tokens/timing; this table stores WHAT the
-- model proposed for a paste (result), what the resolvers made of it
-- (resolved) and — once the agent creates the ticket — which proposals the
-- ticket kept (resolved.applied). Images are never stored (request_summary
-- holds names/sizes + the first 500 chars of pasted text).
-- Idempotent: safe to re-run on dev and prod.

CREATE TABLE IF NOT EXISTS "ticket_intake_runs" (
    "id"              SERIAL PRIMARY KEY,
    "workspace_id"    INTEGER NOT NULL,
    "ticket_id"       INTEGER,
    "actor_email"     VARCHAR(255),
    "actor_name"      VARCHAR(255),
    "text_chars"      INTEGER NOT NULL DEFAULT 0,
    "image_count"     INTEGER NOT NULL DEFAULT 0,
    "provider"        VARCHAR(40),
    "model"           VARCHAR(120),
    "duration_ms"     INTEGER,
    "input_tokens"    INTEGER,
    "output_tokens"   INTEGER,
    "request_summary" JSONB,
    "result"          JSONB NOT NULL,
    "resolved"        JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_intake_runs_workspace_id_fkey"
        FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ticket_intake_runs_ticket_id_fkey"
        FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ticket_intake_runs_workspace_id_created_at_idx"
    ON "ticket_intake_runs" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "ticket_intake_runs_ticket_id_idx"
    ON "ticket_intake_runs" ("ticket_id");
