-- Internal-note editing (FR 08-07 item 8): stamp who/when last edited a
-- thread entry in Ticket Pulse. Prior body versions are appended into
-- raw_payload.editHistory (array of {bodyHtml, bodyText, editedAt, editedBy})
-- — no extra column needed. Additive; safe to re-apply.
ALTER TABLE "ticket_thread_entries" ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(3);
ALTER TABLE "ticket_thread_entries" ADD COLUMN IF NOT EXISTS "edited_by" VARCHAR(255);
