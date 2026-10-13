-- Availability -> Vacation Tracker write-back switch (on by default; needs an API v2 key to do anything).
ALTER TABLE "av_settings" ADD COLUMN IF NOT EXISTS "vt_write_back_enabled" BOOLEAN NOT NULL DEFAULT true;
