-- Track Freshservice snapshot freshness separately from local row updates, and
-- track whether Freshservice activity history was successfully reconciled.
ALTER TABLE "tickets"
  ADD COLUMN "freshservice_updated_at" TIMESTAMP(3),
  ADD COLUMN "activities_synced_at" TIMESTAMP(3),
  ADD COLUMN "activities_sync_freshservice_updated_at" TIMESTAMP(3),
  ADD COLUMN "activities_sync_error" TEXT,
  ADD COLUMN "activities_sync_error_at" TIMESTAMP(3);

CREATE INDEX "tickets_freshservice_updated_at_idx" ON "tickets"("freshservice_updated_at");
CREATE INDEX "tickets_activities_sync_freshservice_updated_at_idx" ON "tickets"("activities_sync_freshservice_updated_at");
