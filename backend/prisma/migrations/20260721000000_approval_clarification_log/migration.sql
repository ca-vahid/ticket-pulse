-- QA 07-14 #1: keep the approval clarification Q&A across resubmits (the
-- question used to live in decision_note and was wiped on resubmit).
ALTER TABLE "ticket_approvals" ADD COLUMN "clarification_log" JSONB;
