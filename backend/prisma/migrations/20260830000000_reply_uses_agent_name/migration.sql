-- Requester replies sent from Ticket Pulse go out under the replying agent's
-- own name ("Susan Xu <ticketpulse@…>", matching FreshService) — per-workspace
-- toggle on the sender-identity row (Mega 08-30 Phase SN2, QA 08-28 #2).
-- Default ON; workspaces with no identity row inherit ON in code.
-- Idempotent; safe to re-apply. Apply to prod BEFORE deploying v3.8.00.
ALTER TABLE "workspace_email_identities"
    ADD COLUMN IF NOT EXISTS "reply_uses_agent_name" BOOLEAN NOT NULL DEFAULT true;
