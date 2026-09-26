// Backfill tickets.reopened_at / reopen_count (QA 09-25 #1) from the
// status_changed history in ticket_activities (last 3 years), with the SAME
// rule the live counter uses (ticketReopenService.computeReopenHistory):
// a Resolved/Closed -> Open/Pending move counts unless the ticket went back
// to Resolved/Closed within 10 minutes (FreshService "System" automation
// flips Closed->Open->Closed in ~30 s — 850 of IT's 1,068 moves in 90 days).
//
// Status names -> base via each workspace's status registry
// (ticket_status_definitions, retired rows included), falling back to
// statusService's heuristic (FS codes 2-5, "resolved"/"closed"/"pending"/
// "open" substrings) for labels the registry never had. Deleted/Spam have no
// base and are ignored as either end of a move.
//
// Dry run by default (per-workspace counts, no writes). --apply writes in
// batches of 500 and only touches tickets whose values change; the write is a
// raw UPDATE so tickets.updated_at is not bumped. Workspaces
// 6, 7, 8, 9 (sandboxes) are skipped unless --all. --ws <id> limits to one.
//
//   DATABASE_URL="<url>" node scripts/backfill-reopened.mjs [--ws 1] [--all] [--apply]
//
// connection_limit=1 is appended to DATABASE_URL here, before Prisma loads.
/* eslint-disable no-console */

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const ONLY_WS = arg('--ws') ? Number(arg('--ws')) : null;
const SANDBOX_WS = new Set([6, 7, 8, 9]);
const BATCH = 500;
const LOOKBACK_MS = 3 * 365 * 86400e3;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — refusing to guess a database.');
  process.exit(1);
}
if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL += `${process.env.DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=1`;
}

const { PrismaClient } = await import('@prisma/client');
const { heuristicBaseStatus } = await import('../src/services/statusService.js');
const { planReopenBackfill, applyReopenBackfillBatch } = await import('../src/services/ticketReopenService.js');
const prisma = new PrismaClient();

function sameDate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

async function workspaceIds() {
  const rows = await prisma.workspace.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  return rows.filter((w) => (ONLY_WS ? w.id === ONLY_WS : ALL || !SANDBOX_WS.has(w.id)));
}

async function baseResolver(workspaceId) {
  const defs = await prisma.ticketStatusDefinition.findMany({
    where: { workspaceId }, select: { name: true, baseStatus: true },
  }).catch(() => []);
  const byName = new Map(defs.map((d) => [d.name.toLowerCase(), d.baseStatus]));
  return (_ticketId, name) => {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return null;
    if (byName.has(key)) return byName.get(key);
    return heuristicBaseStatus(name);
  };
}

const since = new Date(Date.now() - LOOKBACK_MS);
let grandChanged = 0;
try {
  for (const ws of await workspaceIds()) {
    const baseOf = await baseResolver(ws.id);
    // Keyset over ticket ids so one workspace never loads everything at once.
    let lastTicketId = 0;
    const stats = { tickets: 0, reopened: 0, reopens: 0, openNow: 0, changed: 0, written: 0 };
    const pending = [];
    const flush = async () => {
      if (!APPLY || pending.length === 0) { pending.length = 0; return; }
      const batch = pending.splice(0, pending.length);
      // Raw parameterized UPDATE: leaves tickets.updated_at alone (review S4).
      stats.written += await applyReopenBackfillBatch(prisma, batch);
    };
    for (;;) {
      const tickets = await prisma.ticket.findMany({
        where: { workspaceId: ws.id, id: { gt: lastTicketId } },
        select: { id: true, status: true, reopenCount: true, reopenedAt: true },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (tickets.length === 0) break;
      lastTicketId = tickets[tickets.length - 1].id;
      const rows = await prisma.ticketActivity.findMany({
        where: {
          ticketId: { in: tickets.map((t) => t.id) },
          activityType: 'status_changed',
          performedAt: { gte: since },
        },
        select: { ticketId: true, performedAt: true, details: true },
      });
      const plan = planReopenBackfill(rows, baseOf);
      for (const t of tickets) {
        stats.tickets += 1;
        const target = plan.get(t.id) || { reopenCount: 0, reopenedAt: null };
        if (target.reopenCount > 0) {
          stats.reopened += 1;
          stats.reopens += target.reopenCount;
          const base = baseOf(t.id, t.status);
          if (base === 'Open' || base === 'Pending') stats.openNow += 1;
        }
        if ((t.reopenCount || 0) === target.reopenCount && sameDate(t.reopenedAt, target.reopenedAt)) continue;
        stats.changed += 1;
        pending.push({ id: t.id, ...target });
        if (pending.length >= BATCH) await flush();
      }
    }
    await flush();
    grandChanged += stats.changed;
    console.log(`ws${ws.id} ${ws.name}: ${stats.tickets} tickets, ${stats.reopened} reopened (${stats.reopens} stuck reopens, ${stats.openNow} open now), ${stats.changed} to change${APPLY ? `, ${stats.written} written` : ''}`);
  }
  console.log(APPLY ? `Done — ${grandChanged} ticket(s) updated.` : `Dry run — ${grandChanged} ticket(s) would change. Re-run with --apply to write.`);
} finally {
  await prisma.$disconnect();
}
