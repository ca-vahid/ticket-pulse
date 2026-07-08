// Backfill for the Jul 8 thread-actor bug: FS conversation sync stored raw
// RFC-822 headers ('"Andrii Grynik" <it@bgcengineering.ca>') as actor names.
// The transformer + read-time resolver are fixed going forward; this cleans
// the stored rows (last 90 days, all workspaces). Raw SQL — prod schema
// trails the dev Prisma schema.
//
// Pass 1: entries whose actor_freshservice_id matches a synced technician →
//         take the technician's name/email (authoritative identity).
// Pass 2: remaining raw-header names → parse "Name" <email> in SQL.
//
//   Dry run:  node scripts/backfill-thread-actors-0708.mjs
//   Apply:    APPLY=1 node scripts/backfill-thread-actors-0708.mjs
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const envText = readFileSync(new URL('../../reports/agent-reports/.env', import.meta.url), 'utf8');
const url = process.env.PROD_DATABASE_URL || envText.match(/PROD_DATABASE_URL="?([^"\n]+)"?/)?.[1];
const prisma = new PrismaClient({ datasources: { db: { url } } });
const APPLY = process.env.APPLY === '1';
const WINDOW = "occurred_at > NOW() - INTERVAL '90 days'";

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — thread-actor backfill (90 days)\n`);

const [{ total }] = await prisma.$queryRawUnsafe(`
  SELECT COUNT(*) AS total FROM ticket_thread_entries
  WHERE actor_name LIKE '%<%@%>%' AND ${WINDOW}
`);
console.log('raw-header actor names in window:', Number(total));

const [{ tech_matched }] = await prisma.$queryRawUnsafe(`
  SELECT COUNT(*) AS tech_matched
  FROM ticket_thread_entries e
  JOIN technicians t ON t.freshservice_id = e.actor_freshservice_id AND t.workspace_id = e.workspace_id
  WHERE e.actor_name LIKE '%<%@%>%' AND e.${WINDOW}
`);
console.log('  of which resolve to a technician by FS id:', Number(tech_matched));

const samples = await prisma.$queryRawUnsafe(`
  SELECT e.actor_name, t.name AS tech_name
  FROM ticket_thread_entries e
  LEFT JOIN technicians t ON t.freshservice_id = e.actor_freshservice_id AND t.workspace_id = e.workspace_id
  WHERE e.actor_name LIKE '%<%@%>%' AND e.${WINDOW}
  LIMIT 6
`);
for (const s of samples) console.log(`  sample: ${s.actor_name}  ->  ${s.tech_name || '(parse only)'}`);

if (APPLY) {
  const r1 = await prisma.$executeRawUnsafe(`
    UPDATE ticket_thread_entries e
    SET actor_name = t.name,
        actor_email = COALESCE(t.email, e.actor_email)
    FROM technicians t
    WHERE t.freshservice_id = e.actor_freshservice_id
      AND t.workspace_id = e.workspace_id
      AND e.actor_name LIKE '%<%@%>%'
      AND e.${WINDOW}
  `);
  console.log('\npass 1 (technician identity):', r1, 'rows');

  const r2 = await prisma.$executeRawUnsafe(`
    UPDATE ticket_thread_entries
    SET actor_email = CASE
          WHEN actor_email IS NULL OR actor_email LIKE '%<%' OR actor_email = actor_name
          THEN LOWER(TRIM(BOTH '> ' FROM SPLIT_PART(actor_name, '<', 2)))
          ELSE actor_email
        END,
        actor_name = COALESCE(
          NULLIF(TRIM(BOTH ' "' FROM SPLIT_PART(actor_name, '<', 1)), ''),
          LOWER(TRIM(BOTH '> ' FROM SPLIT_PART(actor_name, '<', 2)))
        )
    WHERE actor_name LIKE '%<%@%>%' AND ${WINDOW}
  `);
  console.log('pass 2 (header parse):', r2, 'rows');

  const [{ left }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS left FROM ticket_thread_entries
    WHERE actor_name LIKE '%<%@%>%' AND ${WINDOW}
  `);
  console.log('remaining raw headers:', Number(left));
}
await prisma.$disconnect();
