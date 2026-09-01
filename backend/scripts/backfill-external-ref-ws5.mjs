#!/usr/bin/env node
/**
 * PA-2 (MEGA-0831 Phase PA): backfill Ticket.externalRef for ws5's existing
 * Power Apps intake tickets so the zero-change bridge (workspace custom-field
 * key = power_app_record_id) matches resubmissions of records that were
 * created BEFORE externalRef existed.
 *
 * Rule: for every ws5 API-born ticket whose custom_fields carries
 * power_app_record_id, set external_ref = 'pa-' || rec on the LOWEST id per
 * rec value (the original submission). Later copies in a duplicate group are
 * left NULL — the partial unique index (workspace_id, external_ref) allows
 * exactly one owner per ref. Record '9999' looks like a test record (×6 in
 * prod) and is skipped unless --include-test.
 *
 * Idempotent: a winner that already carries the ref is reported as "set";
 * a ref already owned by ANOTHER ticket is reported as "taken" and skipped.
 *
 * Usage:  node scripts/backfill-external-ref-ws5.mjs [--apply] [--prod] [--include-test] [--workspace=<id>]
 * Default = dry-run against the dev DB. --prod loads PROD_DATABASE_URL from scripts/.env.prod.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');
const INCLUDE_TEST = process.argv.includes('--include-test');
const wsArg = process.argv.find((a) => a.startsWith('--workspace='));
const WORKSPACE_ID = wsArg ? Number(wsArg.split('=')[1]) : 5;
const FIELD_KEY = 'power_app_record_id';
const REF_PREFIX = 'pa-';
const TEST_RECORDS = new Set(['9999']);
const here = path.dirname(fileURLToPath(import.meta.url));

if (PROD) {
  const env = fs.readFileSync(path.join(here, '.env.prod'), 'utf8');
  const m = env.match(/^PROD_DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('PROD_DATABASE_URL missing from scripts/.env.prod');
  process.env.DATABASE_URL = m[1].trim().replace(/^"|"$/g, '');
}
const prisma = new PrismaClient();
console.log(`TARGET: ${PROD ? 'PROD' : 'dev'} database — ${APPLY ? 'APPLY' : 'DRY-RUN'} — workspace ${WORKSPACE_ID} — key ${FIELD_KEY}`);

const ws = await prisma.workspace.findUnique({ where: { id: WORKSPACE_ID }, select: { id: true, name: true, slug: true, externalRefCustomFieldKey: true } });
if (!ws) throw new Error(`Workspace ${WORKSPACE_ID} not found`);
console.log(`workspace ${ws.id}: ${ws.name} (${ws.slug}) — externalRefCustomFieldKey=${ws.externalRefCustomFieldKey ?? 'null'}`);
if (ws.externalRefCustomFieldKey && ws.externalRefCustomFieldKey !== FIELD_KEY) {
  console.log(`WARNING: workspace bridge key is '${ws.externalRefCustomFieldKey}', not '${FIELD_KEY}' — refs derived at runtime would not match this backfill.`);
}

// API-born (source 100), TP-owned, carrying the record id. Raw SQL: the
// JSONB `?` operator has no Prisma-client equivalent.
const rows = await prisma.$queryRaw`
  SELECT id, created_at AS "createdAt", status, external_ref AS "externalRef",
         trim(custom_fields->>${FIELD_KEY}) AS rec
  FROM tickets
  WHERE workspace_id = ${WORKSPACE_ID}
    AND source = 100
    AND origin = 'ticketpulse'
    AND custom_fields ? ${FIELD_KEY}
    AND coalesce(trim(custom_fields->>${FIELD_KEY}), '') <> ''
  ORDER BY id ASC`;
console.log(`${rows.length} API-born ticket(s) carry ${FIELD_KEY}`);

// Existing owners of any 'pa-*' ref in the workspace (idempotency + collisions).
const owners = await prisma.ticket.findMany({
  where: { workspaceId: WORKSPACE_ID, externalRef: { startsWith: REF_PREFIX } },
  select: { id: true, externalRef: true },
});
const ownerByRef = new Map(owners.map((o) => [o.externalRef, o.id]));

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.rec)) groups.set(r.rec, []);
  groups.get(r.rec).push(r);
}

const plan = [];
for (const [rec, members] of [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))) {
  const ref = `${REF_PREFIX}${rec}`;
  const winner = members[0]; // ORDER BY id ASC → lowest id first
  const losers = members.slice(1).map((m) => m.id);
  let action;
  if (TEST_RECORDS.has(rec) && !INCLUDE_TEST) action = 'skip (test record)';
  else if (winner.externalRef === ref) action = 'already set';
  else if (winner.externalRef && winner.externalRef !== ref) action = `skip (winner owns '${winner.externalRef}')`;
  else if (ownerByRef.has(ref) && ownerByRef.get(ref) !== winner.id) action = `skip (ref taken by #${ownerByRef.get(ref)})`;
  else action = 'SET';
  plan.push({ rec, ref, winner: winner.id, winnerStatus: winner.status, copies: members.length, losers, action });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(`\n${pad('rec', 8)}${pad('ref', 12)}${pad('winner', 9)}${pad('status', 10)}${pad('copies', 7)}${pad('losers (left NULL)', 26)}action`);
console.log('-'.repeat(96));
for (const p of plan) {
  console.log(`${pad(p.rec, 8)}${pad(p.ref, 12)}${pad(`#${p.winner}`, 9)}${pad(p.winnerStatus, 10)}${pad(p.copies, 7)}${pad(p.losers.length ? p.losers.map((id) => `#${id}`).join(',') : '-', 26)}${p.action}`);
}
const toSet = plan.filter((p) => p.action === 'SET');
const dupGroups = plan.filter((p) => p.copies > 1);
console.log(`\n${plan.length} group(s); ${dupGroups.length} duplicate group(s) (${dupGroups.reduce((n, p) => n + p.losers.length, 0)} loser row(s) stay NULL); ${toSet.length} to SET; ${plan.filter((p) => p.action === 'already set').length} already set; ${plan.filter((p) => p.action.startsWith('skip')).length} skipped`);

if (!APPLY) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply.'); await prisma.$disconnect(); process.exit(0); }

let done = 0;
for (const p of toSet) {
  try {
    await prisma.ticket.update({ where: { id: p.winner }, data: { externalRef: p.ref } });
    done += 1;
  } catch (err) {
    const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : '';
    console.log(`FAILED #${p.winner} ← ${p.ref}: ${code} ${err.message.split('\n').pop()}`);
  }
}
console.log(`APPLIED: ${done}/${toSet.length} ticket(s) now carry their external_ref`);
await prisma.$disconnect();
