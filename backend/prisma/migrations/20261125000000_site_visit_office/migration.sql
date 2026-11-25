-- Site visits name the office (25 Nov 2026). Vacation Pulse's "Site visit"
-- bookings say which office (av_offices) or a short "Other site" text, and the
-- dashboard rows the assigner reads (technician_leaves) carry the place and,
-- for an office, its time zone.
-- Additive only: nullable columns with no default, so ADD COLUMN is a
-- metadata-only change (no table rewrite, brief ACCESS EXCLUSIVE lock). The
-- foreign key is added NOT VALID and then validated, so the check of existing
-- rows (all NULL) does not hold the stronger lock.

ALTER TABLE "av_requests" ADD COLUMN IF NOT EXISTS "site_office_id" INTEGER;
ALTER TABLE "av_requests" ADD COLUMN IF NOT EXISTS "site_location" VARCHAR(160);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'av_requests_site_office_id_fkey') THEN
    ALTER TABLE "av_requests"
      ADD CONSTRAINT "av_requests_site_office_id_fkey"
      FOREIGN KEY ("site_office_id") REFERENCES "av_offices"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;
ALTER TABLE "av_requests" VALIDATE CONSTRAINT "av_requests_site_office_id_fkey";

ALTER TABLE "technician_leaves" ADD COLUMN IF NOT EXISTS "site_location" VARCHAR(160);
ALTER TABLE "technician_leaves" ADD COLUMN IF NOT EXISTS "site_timezone" VARCHAR(50);
