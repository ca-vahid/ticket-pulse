-- Ingest rung 1b matches inbound In-Reply-To/References against workflow-email Message-IDs.
CREATE INDEX IF NOT EXISTS "notification_deliveries_ws_provider_message_id_idx"
  ON "notification_deliveries" ("workspace_id", "provider_message_id");
