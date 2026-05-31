ALTER TABLE "urgent_escalation_policies"
  ADD COLUMN IF NOT EXISTS "business_urgency_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "business_urgency_notify_assigned" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "business_urgency_notify_supervisors" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "after_hours_response_copy" JSONB,
  ADD COLUMN IF NOT EXISTS "after_hours_response_table" JSONB;
