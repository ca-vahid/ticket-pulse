-- LLM-drafted replies staged for human approval (draft→approve pattern).
CREATE TABLE IF NOT EXISTS "ticket_proposed_replies" (
  "id" SERIAL NOT NULL,
  "workspace_id" INTEGER NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "workflow_run_id" INTEGER,
  "source" VARCHAR(40) NOT NULL DEFAULT 'workflow_llm',
  "subject" VARCHAR(500),
  "body_html" TEXT,
  "body_text" TEXT,
  "confidence" VARCHAR(10),
  "guard_summary" JSONB,
  "status" VARCHAR(20) NOT NULL DEFAULT 'proposed',
  "decided_by" VARCHAR(255),
  "decided_at" TIMESTAMP(3),
  "sent_thread_entry_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ticket_proposed_replies_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ticket_proposed_replies"
  ADD CONSTRAINT "ticket_proposed_replies_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ticket_proposed_replies_ticket_id_status_idx"
  ON "ticket_proposed_replies"("ticket_id", "status");
CREATE INDEX IF NOT EXISTS "ticket_proposed_replies_workspace_id_status_created_at_idx"
  ON "ticket_proposed_replies"("workspace_id", "status", "created_at");
