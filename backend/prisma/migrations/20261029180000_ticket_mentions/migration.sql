-- @mentions in internal notes (29 Oct 2026). Additive: a new table only.
CREATE TABLE IF NOT EXISTS "ticket_mentions" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "thread_entry_id" INTEGER,
  "technician_id" INTEGER NOT NULL,
  "mentioned_by_technician_id" INTEGER,
  "mentioned_by_name" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notified_at" TIMESTAMP(3),
  "notified_via" VARCHAR(40),
  "seen_at" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "ticket_mentions_workspace_id_technician_id_seen_at_idx"
  ON "ticket_mentions"("workspace_id", "technician_id", "seen_at");
CREATE INDEX IF NOT EXISTS "ticket_mentions_ticket_id_technician_id_idx"
  ON "ticket_mentions"("ticket_id", "technician_id");
