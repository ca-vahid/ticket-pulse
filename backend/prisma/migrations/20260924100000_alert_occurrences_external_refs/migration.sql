-- Sentinel integration (24 Sep 2026): alert occurrences + external references. Additive.
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "occurrence_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "last_occurrence_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "ticket_external_references" (
  "id" SERIAL PRIMARY KEY,
  "ticket_id" INTEGER NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "system" VARCHAR(50) NOT NULL,
  "external_id" VARCHAR(200) NOT NULL,
  "number" VARCHAR(50),
  "alert_id" VARCHAR(200),
  "url" VARCHAR(1000),
  "occurred_at" TIMESTAMP(3),
  "ref_key" VARCHAR(300) NOT NULL,
  "created_by" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_external_references_workspace_id_system_ref_key_key" ON "ticket_external_references"("workspace_id", "system", "ref_key");
CREATE INDEX IF NOT EXISTS "ticket_external_references_workspace_id_system_external_id_idx" ON "ticket_external_references"("workspace_id", "system", "external_id");
CREATE INDEX IF NOT EXISTS "ticket_external_references_ticket_id_idx" ON "ticket_external_references"("ticket_id");
