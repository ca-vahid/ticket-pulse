-- Observe-only (mock) mode per FreshService group: the assignment pipeline
-- still runs and records recommendations, but never writes to the ticket.
-- Additive + reversible; built for the AR onboarding observation window.
ALTER TABLE "assignment_configs"
  ADD COLUMN IF NOT EXISTS "observe_only_group_ids" INTEGER[] NOT NULL DEFAULT '{}';
