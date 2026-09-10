-- QA 09-09 #5: merge notes written on the FreshService side never reached
-- Ticket Pulse.
--
-- The preheat cycle decided whether to re-read a ticket's conversations from
-- `newestFsChange` = max(created_at, assigned_at, resolved_at, closed_at). A
-- FreshService merge adds notes to the TARGET ticket without touching any of
-- those, so the target's thread froze; the SOURCE was closed by the same merge,
-- which is why only its note appeared. The same blind spot swallowed any
-- FS-side private note on an otherwise-unchanged ticket.
--
-- The fix keys the decision on freshservice_updated_at (which FreshService does
-- bump when a conversation is added). That needs a per-ticket cursor so a
-- ticket whose updated_at moved for some other reason is not re-fetched every
-- cycle for ever — exactly the role activities_sync_freshservice_updated_at
-- already plays for the activities lane.

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "conversations_sync_freshservice_updated_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "tickets_conversations_sync_freshservice_updated_at_idx"
  ON "tickets" ("conversations_sync_freshservice_updated_at");

-- Backfill: seed the cursor from the activities cursor where we have one, so
-- existing tickets do not all re-fetch on the first cycle after deploy. Where
-- there is no activities cursor either, leaving it NULL is correct — that
-- ticket has never had its conversations checked against a cursor.
UPDATE "tickets"
   SET "conversations_sync_freshservice_updated_at" = "activities_sync_freshservice_updated_at"
 WHERE "conversations_sync_freshservice_updated_at" IS NULL
   AND "activities_sync_freshservice_updated_at" IS NOT NULL;
