/**
 * For run #11 (the latest IT review), reproduce the per-ticket coverage
 * the run saw at collect time, find the 6 zero-context tickets, and
 * check whether their FS state-change timestamps would even land them
 * in the preheat cohort tomorrow.
 */
import prisma from '../src/services/prisma.js';

async function main() {
  const run = await prisma.assignmentDailyReviewRun.findFirst({
    where: { workspaceId: 1 },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, createdAt: true, completedAt: true, evidenceCases: true,
      progress: true,
    },
  });

  const cases = run.evidenceCases || [];
  console.log(`\n=== Run #${run.id} (IT) ===`);
  console.log(`completedAt: ${run.completedAt?.toISOString()}`);
  const elapsedMs = new Date(run.completedAt) - new Date(run.createdAt);
  console.log(`elapsed:     ${(elapsedMs / 1000).toFixed(1)}s\n`);

  // Re-derive the same "ticketsWithNoThreadContext" the UI shows by
  // querying DB state RIGHT NOW. May differ from collect-time if preheat
  // has filled in entries since.
  const allCaseIds = cases.map((c) => c.ticketId);
  const counts = await prisma.ticketThreadEntry.groupBy({
    by: ['ticketId', 'source'],
    where: { ticketId: { in: allCaseIds } },
    _count: { _all: true },
  });
  const byTicket = new Map();
  for (const r of counts) {
    const cur = byTicket.get(r.ticketId) || { activities: 0, conversations: 0 };
    if (r.source === 'freshservice_conversation') cur.conversations = r._count._all;
    else cur.activities = r._count._all;
    byTicket.set(r.ticketId, cur);
  }

  const zeroNow = cases.filter((c) => {
    const cur = byTicket.get(c.ticketId) || { activities: 0, conversations: 0 };
    return cur.activities === 0 && cur.conversations === 0;
  });
  console.log(`Tickets with zero thread entries IN DB RIGHT NOW: ${zeroNow.length}`);
  // Pull full ticket records to understand WHY (newly-created? bypass? etc.)
  for (const c of zeroNow) {
    const t = await prisma.ticket.findUnique({
      where: { id: c.ticketId },
      select: {
        freshserviceTicketId: true, subject: true, status: true,
        createdAt: true, assignedAt: true, resolvedAt: true, closedAt: true,
        descriptionText: true,
      },
    });
    if (!t) continue;
    const ageMin = ((Date.now() - new Date(t.createdAt)) / 60000).toFixed(0);
    console.log(`  #${t.freshserviceTicketId} "${(t.subject || '').slice(0, 60)}"`);
    console.log(`     status=${t.status} ageMin=${ageMin} hasDesc=${!!t.descriptionText}`);
    console.log(`     created=${t.createdAt?.toISOString()}`);
    console.log(`     assigned=${t.assignedAt?.toISOString() || '(never)'}`);
    console.log(`     resolved=${t.resolvedAt?.toISOString() || '(never)'}`);
    console.log(`     closed=${t.closedAt?.toISOString() || '(never)'}`);
  }

  // Show progress trail
  console.log(`\n=== Progress payload at end ===`);
  console.log(JSON.stringify(run.progress, null, 2).slice(0, 1500));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
