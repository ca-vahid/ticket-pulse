-- "Updated" must mean REAL activity (messages, assignments, status changes),
-- not FS's updated_at, which FS-side automations bump on idle tickets.
ALTER TABLE "tickets" ADD COLUMN "last_real_activity_at" TIMESTAMP(3);

-- Backfill from observable events: conversation entries with an actual body,
-- audit/FS activities, resolution, creation.
UPDATE "tickets" t SET "last_real_activity_at" = GREATEST(
  t."created_at",
  COALESCE(t."resolved_at", t."created_at"),
  COALESCE((
    SELECT max(e."occurred_at") FROM "ticket_thread_entries" e
    WHERE e."ticket_id" = t."id"
      AND (e."body_text" IS NOT NULL OR e."body_html" IS NOT NULL OR e."content" IS NOT NULL)
  ), t."created_at"),
  COALESCE((
    SELECT max(a."performed_at") FROM "ticket_activities" a
    WHERE a."ticket_id" = t."id"
  ), t."created_at")
);

CREATE INDEX "tickets_workspace_id_last_real_activity_at_idx" ON "tickets"("workspace_id", "last_real_activity_at" DESC);
