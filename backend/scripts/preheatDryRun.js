/**
 * Dry-run: run the same queries _preheatTicketThreads would run against
 * prod and report what work it WOULD do, without firing any FreshService
 * calls. Useful for verifying the new code paths after a schema-only
 * deploy and before the application code rolls out.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/preheatDryRun.js [workspaceId]
 */
import { formatInTimeZone } from 'date-fns-tz';
import prisma from '../src/services/prisma.js';

const workspaceArg = process.argv[2] ? Number(process.argv[2]) : null;

async function dryRun(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, defaultTimezone: true },
  });
  if (!workspace) {
    console.log(`workspace ${workspaceId}: not found`);
    return;
  }
  const tz = workspace.defaultTimezone || 'America/Los_Angeles';
  const todayLocal = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
  const startIso = formatInTimeZone(
    new Date(`${todayLocal}T12:00:00.000Z`), tz,
    `yyyy-MM-dd'T'00:00:00XXX`,
  );
  const startOfDay = new Date(startIso);

  const cohort = await prisma.ticket.findMany({
    where: {
      workspaceId,
      OR: [
        { createdAt: { gte: startOfDay } },
        { assignedAt: { gte: startOfDay } },
        { resolvedAt: { gte: startOfDay } },
        { closedAt: { gte: startOfDay } },
      ],
    },
    select: {
      id: true, freshserviceTicketId: true,
      createdAt: true, assignedAt: true, resolvedAt: true, closedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (cohort.length === 0) {
    console.log(`ws=${workspaceId} (${workspace.name}, tz=${tz}): no today-cohort tickets since ${startOfDay.toISOString()}`);
    return;
  }

  const latestRows = await prisma.ticketThreadEntry.groupBy({
    by: ['ticketId', 'source'],
    where: { workspaceId, ticketId: { in: cohort.map((t) => t.id) } },
    _max: { occurredAt: true },
  });
  const latestByPair = new Map();
  for (const row of latestRows) {
    latestByPair.set(`${row.ticketId}::${row.source}`, row._max.occurredAt);
  }

  const newestFsChange = (t) => {
    const candidates = [t.createdAt, t.assignedAt, t.resolvedAt, t.closedAt]
      .filter(Boolean).map((d) => d.getTime());
    return candidates.length > 0 ? new Date(Math.max(...candidates)) : null;
  };

  let activitiesNeeded = 0;
  let conversationsNeeded = 0;
  let bothFresh = 0;
  for (const t of cohort) {
    const la = latestByPair.get(`${t.id}::freshservice_activity`);
    const lc = latestByPair.get(`${t.id}::freshservice_conversation`);
    const fsChange = newestFsChange(t);
    const aStale = !la || (fsChange && la < fsChange);
    const cStale = !lc || (fsChange && lc < fsChange);
    if (aStale) activitiesNeeded += 1;
    if (cStale) conversationsNeeded += 1;
    if (!aStale && !cStale) bothFresh += 1;
  }

  console.log(
    `ws=${workspaceId} (${workspace.name}, tz=${tz}): ` +
    `cohort=${cohort.length} | both-fresh=${bothFresh} | ` +
    `would-fetch activities=${activitiesNeeded}, conversations=${conversationsNeeded} | ` +
    `cap=60 → would actually hydrate ${Math.min(60, Math.max(activitiesNeeded, conversationsNeeded))} ticket(s) this cycle`,
  );
}

async function main() {
  const workspaces = workspaceArg
    ? [{ id: workspaceArg }]
    : await prisma.workspace.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const ws of workspaces) {
    try {
      await dryRun(ws.id);
    } catch (err) {
      console.error(`ws=${ws.id}: dry-run failed`, err.message);
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
