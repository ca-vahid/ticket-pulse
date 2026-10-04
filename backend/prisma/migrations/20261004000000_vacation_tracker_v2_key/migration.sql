-- Vacation Tracker API v2 key for Availability two-way sync (additive).
ALTER TABLE "vacation_tracker_configs" ADD COLUMN IF NOT EXISTS "api_key_v2" TEXT;
