-- Availability: per-person yearly allowance by leave type (additive).
ALTER TABLE "av_people" ADD COLUMN IF NOT EXISTS "entitlement_overrides" JSONB;
