/**
 * Backfill arrival channel for existing TP-born tickets (QA 07-07 #1).
 * Set-only (source IS NULL): email-ingested tickets (their first thread entry
 * came from the mailbox) get 1 (Email); everything else was created by staff
 * in the app → 103 (Agent). FS-born tickets keep FreshService's own codes.
 *
 * Run from backend/:  node scripts/backfill-tp-source.mjs        (dev)
 *                     PROD=1 node scripts/backfill-tp-source.mjs (prod)
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const dbUrl = process.env.PROD
  ? loadEnv(path.resolve(__dirname, '.env.prod')).PROD_DATABASE_URL
  : loadEnv(path.resolve(__dirname, '../.env')).DATABASE_URL;
if (!dbUrl) { console.error('No database URL'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// Email-ingested: the ticket's earliest thread entry is an inbound email.
const emailUpdated = await prisma.$executeRawUnsafe(`
  UPDATE tickets t SET source = 1
  WHERE t.origin = 'ticketpulse' AND t.source IS NULL
    AND EXISTS (
      SELECT 1 FROM ticket_thread_entries e
      WHERE e.ticket_id = t.id AND e.source = 'email_inbound'
    )
`);
const agentUpdated = await prisma.$executeRawUnsafe(`
  UPDATE tickets t SET source = 103
  WHERE t.origin = 'ticketpulse' AND t.source IS NULL
`);
const counts = await prisma.$queryRawUnsafe(`
  SELECT source, COUNT(*)::int AS n FROM tickets
  WHERE origin = 'ticketpulse' GROUP BY source ORDER BY source
`);
console.log(`Email (1): ${emailUpdated} set · Agent (103): ${agentUpdated} set`);
console.log('TP-born by source:', JSON.stringify(counts));
await prisma.$disconnect();
