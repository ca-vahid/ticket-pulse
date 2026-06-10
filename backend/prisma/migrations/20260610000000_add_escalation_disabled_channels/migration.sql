-- Workspace-level pause list for escalation channels (sms / whatsapp / phone_call).
-- Paused channels are skipped by escalation sends and excluded from readiness warnings.
ALTER TABLE "urgent_escalation_policies"
  ADD COLUMN IF NOT EXISTS "disabled_channels" TEXT[] NOT NULL DEFAULT '{}';
