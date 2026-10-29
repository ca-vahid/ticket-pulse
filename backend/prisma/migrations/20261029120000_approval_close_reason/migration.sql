-- Closing an approval without a decision (29 Oct 2026): the reason the approver
-- picked (not_needed | handled_otherwise | duplicate | other) on status = 'closed'.
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "close_reason" VARCHAR(40);
