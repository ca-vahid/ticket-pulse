#!/usr/bin/env node
/**
 * DR6 (MEGA-0830): repair display-only duplicate thread entries created by the
 * fs-conv-<id> / fs-conversation:<id> namespace split (fixed in v3.8.00).
 *
 * For each TP-authored entry stamped `fs-conv-<id>` that has an FS-ingested twin
 * stamped `fs-conversation:<id>` on the same ticket:
 *   1. re-link any ticket_attachments from the twin to the local row
 *   2. delete the twin (it is the same FreshService conversation, re-ingested)
 *   3. re-stamp the local row to the canonical `fs-conversation:<id>` so future
 *      syncs merge into it (v3.8.00 bulkUpsert preserves TP attribution)
 * Legacy `fs-conv-*` rows WITHOUT a twin are re-stamped too (step 3 only).
 *
 * Usage:  node scripts/repair-duplicate-thread-entries-0830.mjs [--apply] [--prod]
 * Default = dry-run against the dev DB. --prod loads PROD_DATABASE_URL from scripts/.env.prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
const prisma = new PrismaClient();
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const pairs = await prisma.$queryRawUnsafe(`
  SELECT a.id AS local_id, a.ticket_id, a.actor_name, a.external_entry_id AS local_ext,
         b.id AS twin_id, b.actor_name AS twin_actor,
         substring(a.external_entry_id from 9) AS conv_id
  FROM ticket_thread_entries a
  JOIN ticket_thread_entries b
    ON b.ticket_id = a.ticket_id
   AND b.external_entry_id = 'fs-conversation:' || substring(a.external_entry_id from 9)
  WHERE a.external_entry_id LIKE 'fs-conv-%' AND a.source = 'ticketpulse_user'
  ORDER BY a.ticket_id, a.id`);
const orphans = await prisma.$queryRawUnsafe(`
  SELECT a.id, a.ticket_id, substring(a.external_entry_id from 9) AS conv_id
  FROM ticket_thread_entries a
  WHERE a.external_entry_id LIKE 'fs-conv-%'
    AND NOT EXISTS (SELECT 1 FROM ticket_thread_entries b WHERE b.ticket_id = a.ticket_id
                    AND b.external_entry_id = 'fs-conversation:' || substring(a.external_entry_id from 9))`);
const twinIds = pairs.map((p) => p.twin_id);
const attRows = twinIds.length
  ? await prisma.$queryRawUnsafe(`SELECT id, thread_entry_id FROM ticket_attachments WHERE thread_entry_id = ANY($1::int[])`, twinIds)
  : [];

console.log(`duplicate pairs: ${pairs.length} across ${new Set(pairs.map((p) => p.ticket_id)).size} tickets`);
console.log(`legacy fs-conv- rows without a twin (re-stamp only): ${orphans.length}`);
console.log(`attachments linked to twins (will be re-linked): ${attRows.length}`);
for (const p of pairs.slice(0, 80)) {
  console.log(`  ticket ${p.ticket_id}: keep #${p.local_id} (${p.actor_name}) / drop #${p.twin_id} (${p.twin_actor}) conv ${p.conv_id}`);
}
if (pairs.length > 80) console.log(`  … ${pairs.length - 80} more`);

if (!APPLY) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }

let relinked = 0, deleted = 0, restamped = 0;
await prisma.$transaction(async (tx) => {
  for (const p of pairs) {
    const r = await tx.$executeRawUnsafe(`UPDATE ticket_attachments SET thread_entry_id = $1 WHERE thread_entry_id = $2`, p.local_id, p.twin_id);
    relinked += r;
    deleted += await tx.$executeRawUnsafe(`DELETE FROM ticket_thread_entries WHERE id = $1`, p.twin_id);
    restamped += await tx.$executeRawUnsafe(`UPDATE ticket_thread_entries SET external_entry_id = $1 WHERE id = $2`, `fs-conversation:${p.conv_id}`, p.local_id);
  }
  for (const o of orphans) {
    restamped += await tx.$executeRawUnsafe(`UPDATE ticket_thread_entries SET external_entry_id = $1 WHERE id = $2`, `fs-conversation:${o.conv_id}`, o.id);
  }
});
console.log(`APPLIED: relinked ${relinked} attachments, deleted ${deleted} twins, re-stamped ${restamped} rows`);
const left = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM ticket_thread_entries WHERE external_entry_id LIKE 'fs-conv-%'`);
console.log(`remaining fs-conv- rows: ${left[0].n} (expect 0)`);
await prisma.$disconnect();
