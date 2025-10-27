-- Add time tracking fields to tickets table
ALTER TABLE "tickets" ADD COLUMN "time_spent_minutes" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "billable_minutes" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "non_billable_minutes" INTEGER;
