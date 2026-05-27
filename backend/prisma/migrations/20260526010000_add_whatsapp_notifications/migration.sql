-- Add WhatsApp as an explicit per-agent notification opt-in channel.

ALTER TABLE "technician_notification_preferences"
  ADD COLUMN "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false;
