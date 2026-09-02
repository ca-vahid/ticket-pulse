#!/usr/bin/env node
/**
 * MEGA 09-01 Phase RO/TU — live query-shape probe against the DEV database.
 * Every new Prisma query shape introduced by the phase runs ONCE here so a
 * mocked-Prisma test can't hide a runtime validation error (the lesson from
 * the v3.0.77 `findFirst include` 500). Read-mostly: the only writes touch
 * `last_reconciled_at` on one dev ticket (the new cursor column).
 *
 * Usage: node scripts/qa-0902-ro-query-probe.mjs   (dev DB from backend/.env)
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
if (/azure|prod/i.test(process.env.DATABASE_URL || '')) throw new Error('refusing to probe a non-dev DATABASE_URL');

const results = [];
async function probe(name, fn) {
  try {
    const out = await fn();
    results.push({ name, ok: true, note: typeof out === 'string' ? out : JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 140) });
  } catch (error) {
    results.push({ name, ok: false, note: error.message.split('\n')[0].slice(0, 200) });
  }
}

const sample = await prisma.ticket.findFirst({
  where: { origin: 'freshservice', freshserviceTicketId: { not: null } },
  orderBy: { id: 'desc' },
  select: { id: true, workspaceId: true, freshserviceTicketId: true, status: true, lastReconciledAt: true },
});
if (!sample) throw new Error('dev DB has no FS-born ticket to probe with');
const { id: ticketId, workspaceId } = sample;

await probe('reconcile cursor: findMany orderBy lastReconciledAt nulls first', () => prisma.ticket.findMany({
  where: { workspaceId, origin: 'freshservice', status: { notIn: ['Closed', 'Resolved', 'Deleted', 'Spam'] } },
  select: { id: true, freshserviceTicketId: true, subject: true, status: true, assignedTechId: true },
  orderBy: [{ lastReconciledAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  take: 3,
}).then((rows) => `${rows.length} rows`));

await probe('reconcile touch: $executeRaw UPDATE last_reconciled_at', () => prisma.$executeRaw`UPDATE tickets SET last_reconciled_at = NOW() WHERE id = ${ticketId}`);
await probe('reconcile drift write: ticket.update lastReconciledAt', () => prisma.ticket.update({
  where: { id: ticketId }, data: { lastReconciledAt: new Date() }, select: { id: true, lastReconciledAt: true },
}));
await probe('restore sample lastReconciledAt', () => prisma.ticket.update({
  where: { id: ticketId }, data: { lastReconciledAt: sample.lastReconciledAt }, select: { id: true },
}));

await probe('upsert guard where: status notIn Spam/Deleted + origin', () => prisma.ticket.findMany({
  where: { freshserviceTicketId: sample.freshserviceTicketId, origin: 'freshservice', status: { notIn: ['Spam', 'Deleted'] } },
  select: { id: true },
}));

await probe('sync guard: fs_write_back findFirst', () => prisma.ticketActivity.findFirst({
  where: { ticketId, activityType: 'fs_write_back', performedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
  orderBy: { performedAt: 'desc' },
  select: { performedAt: true, details: true },
}).then((r) => (r ? 'row' : 'none')));

await probe('duplicate status row: status_changed findFirst', () => prisma.ticketActivity.findFirst({
  where: { ticketId, activityType: 'status_changed' },
  orderBy: { performedAt: 'desc' },
  select: { performedAt: true, details: true },
}).then((r) => (r ? 'row' : 'none')));

await probe('mirror_conflict dedupe: findFirst select id/details', () => prisma.ticketActivity.findFirst({
  where: { ticketId, activityType: 'mirror_conflict' },
  orderBy: { performedAt: 'desc' },
  select: { id: true, details: true },
}).then((r) => (r ? 'row' : 'none')));

await probe('FS actor fallback: ticketThreadEntry status_event findMany', () => prisma.ticketThreadEntry.findMany({
  where: { ticketId, source: 'freshservice_activity', eventType: 'status_event', occurredAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) } },
  orderBy: { occurredAt: 'desc' },
  take: 10,
  select: { actorName: true, actorFreshserviceId: true, content: true, occurredAt: true },
}).then((rows) => `${rows.length} rows`));

await probe('reply attribution: technician findMany email/fsId OR', () => prisma.technician.findMany({
  where: { workspaceId: { in: [workspaceId] }, OR: [{ email: { in: ['nobody@example.com'], mode: 'insensitive' } }, { freshserviceId: { in: [BigInt(1)] } }] },
  select: { email: true, freshserviceId: true },
}).then((rows) => `${rows.length} rows`));

await probe('activities window: findMany take 200', () => prisma.ticketActivity.findMany({
  where: { ticketId }, orderBy: { performedAt: 'desc' }, take: 200,
}).then((rows) => `${rows.length} rows`));

await probe('reopen workflow row (ws2)', () => prisma.notificationWorkflow.findFirst({
  where: { workspaceId: 2, key: 'ticket_reply_received_reopen' },
  select: { id: true, isEnabled: true, mockModeEnabled: true, publishedVersion: true },
}));

await prisma.$disconnect();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} — ${r.note}`);
}
console.log(`\n${results.length - failed}/${results.length} query shapes OK against dev (ticket #${ticketId}, ws${workspaceId})`);
process.exit(failed ? 1 : 0);
