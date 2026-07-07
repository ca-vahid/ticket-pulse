-- Approval rich text (gap plan P2.4): sanitized HTML variants of the request
-- and decision/clarification notes. Additive.

ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "request_note_html" TEXT;
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "decision_note_html" TEXT;
