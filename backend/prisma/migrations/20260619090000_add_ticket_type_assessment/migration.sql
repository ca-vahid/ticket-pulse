ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "ticket_type" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "assessed_ticket_type" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "ticket_type_rationale" TEXT,
  ADD COLUMN IF NOT EXISTS "ticket_type_confidence" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "ticket_type_assessed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ticket_type_assessed_by_run_id" INTEGER;

CREATE INDEX IF NOT EXISTS "tickets_ticket_type_idx" ON "tickets"("ticket_type");
CREATE INDEX IF NOT EXISTS "tickets_assessed_ticket_type_idx" ON "tickets"("assessed_ticket_type");
CREATE INDEX IF NOT EXISTS "tickets_ticket_type_assessed_at_idx" ON "tickets"("ticket_type_assessed_at");

ALTER TABLE "assignment_pipeline_runs"
  ADD COLUMN IF NOT EXISTS "ticket_type_writeback_status" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "ticket_type_writeback_payload" JSONB,
  ADD COLUMN IF NOT EXISTS "ticket_type_writeback_error" TEXT,
  ADD COLUMN IF NOT EXISTS "ticket_type_written_at" TIMESTAMP(3);
