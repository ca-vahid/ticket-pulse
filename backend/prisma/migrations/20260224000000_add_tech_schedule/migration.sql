-- Per-technician work schedule (HH:MM in their own timezone, nullable = use global business hours)
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "work_start_time" VARCHAR(5);
ALTER TABLE "technicians" ADD COLUMN IF NOT EXISTS "work_end_time" VARCHAR(5);
