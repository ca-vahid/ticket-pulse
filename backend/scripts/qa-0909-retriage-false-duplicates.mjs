/**
 * QA 09-09 #1 — return Accounting's wrongly-dismissed invoices to the queue.
 *
 * The duplicate-burst guard matched on subject alone, so recurring-vendor
 * invoices that share a template subject were collapsed onto each other:
 * 17 Instacart, 10 Starlink, 5 FedEx and more in 30 days. v3.8.49 teaches the
 * guard to read the body (and, when the body is empty, the attachments), but
 * that only protects tickets from here on. This reverses the ones already
 * dismissed.
 *
 * Only reverses dismissals the NEW rule disagrees with — a genuine repeat
 * (identical body and attachments) stays a duplicate.
 *
 *   node scripts/qa-0909-retriage-false-duplicates.mjs            # dry run
 *   node scripts/qa-0909-retriage-false-duplicates.mjs --apply
 */
import prisma from '../src/services/prisma.js';
import { normalizeSubject, contentAgrees } from '../src/services/duplicateBurstService.js';

const APPLY = process.argv.includes('--apply');
const WORKSPACE = Number(process.env.WORKSPACE_ID || 2);
const DAYS = Number(process.env.DAYS || 60);

const rows = await prisma.$queryRawUnsafe(`
  SELECT t.id, t.freshservice_ticket_id::text AS fs, t.native_number, t.origin, t.status,
         t.subject, coalesce(t.description_text, t.description, '') AS body,
         req.email AS sender, r.id AS run_id, t.created_at
  FROM assignment_pipeline_runs r
  JOIN tickets t ON t.id = r.ticket_id
  LEFT JOIN requesters req ON req.id = t.requester_id
  WHERE t.workspace_id = $1 AND r.decision = 'duplicate_dismissed'
    AND r.created_at > now() - ($2 || ' days')::interval
  ORDER BY req.email, t.created_at`, WORKSPACE, String(DAYS));

const files = await prisma.ticketAttachment.findMany({
  where: { ticketId: { in: rows.map((r) => r.id) } },
  select: { ticketId: true, fileName: true, sizeBytes: true },
});
const byTicket = new Map();
for (const f of files) {
  if (!byTicket.has(f.ticketId)) byTicket.set(f.ticketId, []);
  byTicket.get(f.ticketId).push(f);
}
const content = (r) => ({ body: r.body, attachments: byTicket.get(r.id) || [] });

// Rebuild the guard's own grouping: same sender, same normalized subject.
const groups = new Map();
for (const r of rows) {
  const key = `${r.sender}||${normalizeSubject(r.subject)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const wrong = [];
for (const items of groups.values()) {
  if (items.length < 2) continue;
  const [first, ...rest] = items;
  for (const item of rest) {
    if (!contentAgrees(content(first), content(item))) wrong.push({ ...item, originalFs: first.fs });
  }
}

const CSV = process.argv.includes('--csv');

if (!CSV) {
  console.log(`workspace ${WORKSPACE}, last ${DAYS} days`);
  console.log(`  ${rows.length} duplicate dismissals examined`);
  console.log(`  ${wrong.length} were NOT duplicates under the new rule\n`);
  for (const w of wrong) {
    console.log(`  #${w.fs} ${String(w.sender || '?').slice(0, 30).padEnd(30)} ${(w.subject || '').slice(0, 44)}  [was "dupe of" #${w.originalFs}]`);
  }
}

// CSV for Accounting to check against what was actually paid. Preferred over a
// mass reversal: these tickets are FS-born and almost all Closed in
// FreshService, so reopening them in Ticket Pulse's queue would surface work
// the system of record considers finished, and would write a note onto every
// one of them. The list lets Kirsten confirm the invoices were processed; the
// "Not a duplicate" button reverses any individual one that was not.
if (CSV) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  process.stdout.write(['fs_ticket', 'sender', 'subject', 'status', 'created', 'was_marked_duplicate_of'].join(',') + '\n');
  for (const w of wrong) {
    process.stdout.write([w.fs, w.sender, w.subject, w.status, new Date(w.created_at).toISOString().slice(0, 10), w.originalFs].map(esc).join(',') + '\n');
  }
  await prisma.$disconnect();
  process.exit(0);
}

if (!APPLY) {
  console.log('\n(dry run — pass --apply to reverse these, or --csv for the handover list)');
  await prisma.$disconnect();
  process.exit(0);
}

const { default: ticketLinkService } = await import('../src/services/ticketLinkService.js');
const actor = { name: 'Ticket Pulse duplicate-guard correction', email: null };

let ok = 0;
let failed = 0;
for (const w of wrong) {
  try {
    const res = await ticketLinkService.notDuplicate(w.id, WORKSPACE, actor);
    ok += 1;
    console.log(`  reversed #${w.fs} — unlinked ${res.unlinked}, runs reverted ${res.reverted}, reopened ${res.reopened}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAILED  #${w.fs}: ${err.message}`);
  }
}
console.log(`\nreversed ${ok}, failed ${failed}`);

await prisma.$disconnect();
