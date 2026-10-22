-- Who wrote a TP-born ticket (+ New ticket). A technician's own ticket assigned to
-- themselves counts as "Logged", not "Self" (utils/assignerKind.js, 22 Oct 2026).
-- Nullable, no default: instant on a live table.
ALTER TABLE "tickets" ADD COLUMN "created_by_tech_id" INTEGER;

-- Backfill from each TP-born ticket's "created" activity written by a person. When
-- two technician rows share the e-mail, prefer the one that owns the ticket.
UPDATE "tickets" t
SET "created_by_tech_id" = pick.id
FROM (
  SELECT DISTINCT ON (t2.id) t2.id AS ticket_id, tech.id
  FROM "tickets" t2
  JOIN "ticket_activities" a
    ON a."ticket_id" = t2.id
   AND a."activityType" = 'created'
   AND a."details"->>'actorKind' = 'human'
  JOIN "technicians" tech
    ON lower(tech."email") = lower(a."details"->>'actorEmail')
   AND tech."workspace_id" = t2."workspace_id"
  WHERE t2."origin" = 'ticketpulse'
  ORDER BY t2.id, (tech.id = t2."assigned_tech_id") DESC NULLS LAST, tech."is_active" DESC NULLS LAST, tech.id
) pick
WHERE t.id = pick.ticket_id
  AND t."created_by_tech_id" IS NULL;
