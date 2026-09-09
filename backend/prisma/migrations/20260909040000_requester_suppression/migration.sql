-- Phantom requester cleanup + honest directory lookups (QA 09-09).
--
-- suppressed_at hides a requester from pickers WITHOUT using is_active, which
-- the FreshService requester sync overwrites from FreshService every cycle.
-- entra_missing_at records a directory miss, which used to be written into
-- entra_profile_synced_at and so looked like a successful enrichment.
ALTER TABLE "requesters"
  ADD COLUMN IF NOT EXISTS "entra_missing_at"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suppressed_at"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suppressed_reason"  VARCHAR(60);

CREATE INDEX IF NOT EXISTS "requesters_suppressed_at_idx" ON "requesters" ("suppressed_at");
