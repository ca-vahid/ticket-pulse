-- Add workspace-scoped after-hours urgent escalation settings.
ALTER TABLE "assignment_configs"
  ADD COLUMN "after_hours_urgent_escalation_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "after_hours_urgent_escalation_channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "after_hours_urgent_escalation_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "after_hours_urgent_escalation_phones" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Escalation notifications are workspace recipients, not necessarily agents.
ALTER TABLE "notification_deliveries"
  ALTER COLUMN "technician_id" DROP NOT NULL;
