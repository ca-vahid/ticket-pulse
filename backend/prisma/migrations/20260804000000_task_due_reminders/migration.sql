-- Task due-time reminders (QA 08-04 #8b): "Notify before" minutes + the
-- idempotency stamp for the sent reminder. Additive; safe to re-apply.
ALTER TABLE "ticket_tasks" ADD COLUMN IF NOT EXISTS "remind_before_minutes" INTEGER;
ALTER TABLE "ticket_tasks" ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMP(3);
