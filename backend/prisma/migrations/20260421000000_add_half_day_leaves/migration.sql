-- Half-day leave support for Vacation Tracker integration.
-- All columns are nullable / default true so existing rows remain valid
-- and full-day leaves continue to render unchanged.

ALTER TABLE "technician_leaves"
    ADD COLUMN "is_full_day"    BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "half_day_part"  VARCHAR(2),
    ADD COLUMN "start_minute"   INTEGER,
    ADD COLUMN "end_minute"     INTEGER;
