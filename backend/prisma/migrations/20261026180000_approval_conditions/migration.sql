-- Approve with conditions as a conversation (26 Oct 2026). Additive only: one
-- nullable JSONB column on ticket_approvals (instant on a live table).
ALTER TABLE "ticket_approvals" ADD COLUMN IF NOT EXISTS "conditions" JSONB;
