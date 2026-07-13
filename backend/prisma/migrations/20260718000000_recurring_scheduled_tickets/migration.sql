-- Recurring scheduled tickets (QA 07-13 #2): the existing one-shot scheduler
-- gains recurrence. The first fire's wall-clock (in `timezone`) defines the
-- pattern anchor; the sweep re-arms scheduled_for_at after each spawn.
ALTER TABLE "scheduled_tickets" ADD COLUMN "recurrence" VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE "scheduled_tickets" ADD COLUMN "recurrence_day" INTEGER;
ALTER TABLE "scheduled_tickets" ADD COLUMN "recurrence_month" INTEGER;
ALTER TABLE "scheduled_tickets" ADD COLUMN "timezone" VARCHAR(50);
ALTER TABLE "scheduled_tickets" ADD COLUMN "end_at" TIMESTAMP(3);
ALTER TABLE "scheduled_tickets" ADD COLUMN "last_spawned_at" TIMESTAMP(3);
