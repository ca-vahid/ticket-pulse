ALTER TABLE "tickets"
ADD COLUMN "last_ingest_source" VARCHAR(60),
ADD COLUMN "last_ingested_at" TIMESTAMP(3),
ADD COLUMN "last_webhook_ingested_at" TIMESTAMP(3),
ADD COLUMN "webhook_ingest_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "tickets_last_ingest_source_idx" ON "tickets"("last_ingest_source");
CREATE INDEX "tickets_workspace_id_last_webhook_ingested_at_idx" ON "tickets"("workspace_id", "last_webhook_ingested_at");
