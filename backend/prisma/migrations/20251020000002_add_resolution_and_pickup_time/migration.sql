-- Add resolution time and first assigned timestamp fields
ALTER TABLE "tickets" ADD COLUMN "resolution_time_seconds" INTEGER;
ALTER TABLE "tickets" ADD COLUMN "first_assigned_at" TIMESTAMP;

-- Add comments for clarity
COMMENT ON COLUMN "tickets"."resolution_time_seconds" IS 'Time from ticket creation to resolution in seconds (from FreshService stats.resolution_time_in_secs)';
COMMENT ON COLUMN "tickets"."first_assigned_at" IS 'Timestamp when ticket was first assigned to a technician (from FreshService activities API)';
