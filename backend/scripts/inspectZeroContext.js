/**
 * Find the tickets in the latest daily review run that reached the LLM
 * with NO thread context, by reading the threadCounts that the run
 * itself stored at collect-time (not by re-querying the DB now, which
 * may have grown since).
 */
import prisma from '../src/services/prisma.js';

async function main() {
  const run = await prisma.assignmentDailyReviewRun.findFirst({
    where: { workspaceId: 1 },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      completedAt: true,
      evidenceCases: true,
    },
  });
  if (!run) { console.log('no run'); return; }
  console.log(`Run #${run.id}, completed ${run.completedAt?.toISOString()}\n`);

  const cases = Array.isArray(run.evidenceCases) ? run.evidenceCases : [];
  console.log(`evidenceCases: ${cases.length}\n`);

  // The case object stores `threadExcerpts` — that's what the LLM saw.
  const noContext = cases.filter((c) => !c.threadExcerpts || c.threadExcerpts.length === 0);
  console.log(`zero threadExcerpts at LLM time: ${noContext.length}\n`);

  for (const c of noContext) {
    console.log(`  #${c.freshserviceTicketId} (db=${c.ticketId}) "${(c.subject || '').slice(0, 70)}"`);
    console.log(`    type=${c.type}, status=${c.status}, decision=${c.decision}, triggerSource=${c.triggerSource}`);
    console.log(`    descriptionText: ${c.descriptionText ? `${c.descriptionText.length}ch` : '(none)'}`);
    console.log(`    requester: ${c.requester?.name || '(none)'}`);

    // Now query DB for what's actually there for this ticket
    const cnt = await prisma.ticketThreadEntry.groupBy({
      by: ['source'],
      where: { ticketId: c.ticketId },
      _count: { _all: true },
    });
    const summary = cnt.map((r) => `${r.source}=${r._count._all}`).join(', ');
    console.log(`    DB now: ${summary || '(still nothing)'}`);

    // Most recent entry
    const recent = await prisma.ticketThreadEntry.findFirst({
      where: { ticketId: c.ticketId },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true, source: true },
    });
    if (recent) {
      console.log(`    most recent entry syncedAt: ${recent.syncedAt?.toISOString()} (${recent.source})`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
