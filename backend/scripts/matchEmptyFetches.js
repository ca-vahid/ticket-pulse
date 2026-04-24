/**
 * From the terminal log we see these FS tickets returned 0 items from
 * /conversations during the run window:
 *   219631, 219455, 219811, 219817, 219721, 219599, 219721, 219817
 * Cross-reference these against the run's evidenceCases to confirm
 * they're the same 6 "no thread context" tickets shown in the UI.
 */
import prisma from '../src/services/prisma.js';

// FS ticket IDs that returned 0 conversations during the post-run preheat
// (cherry-picked from terminals/6.txt around 22:22:00-22:22:30)
const EMPTY_FS_IDS = [
  219631, 219648, 219721, 219455, 219811, 219817, 219599, 219604, 219567, 208457,
];

async function main() {
  // Latest IT run
  const run = await prisma.assignmentDailyReviewRun.findFirst({
    where: { workspaceId: 1 },
    orderBy: { createdAt: 'desc' },
    select: { id: true, evidenceCases: true },
  });
  const cases = run.evidenceCases || [];

  // Collect-time threadCounts cannot be re-derived from evidenceCases alone
  // (we don't store them per case). But the run's screenshot showed:
  //   42 with conversations, 46 with activity log, 6 with no thread context
  // For each EMPTY_FS_IDS, check whether it was in the run AND what its
  // current entry counts look like.
  console.log(`Run #${run.id}: cross-checking empty FS fetches vs case set\n`);

  for (const fsId of EMPTY_FS_IDS) {
    const c = cases.find((x) => Number(x.freshserviceTicketId) === fsId);
    if (!c) {
      console.log(`  #${fsId}: NOT in this run's case set`);
      continue;
    }
    const cnt = await prisma.ticketThreadEntry.groupBy({
      by: ['source'],
      where: { ticketId: c.ticketId },
      _count: { _all: true },
    });
    const summary = cnt.length === 0
      ? '(NO entries — would show as "no thread context")'
      : cnt.map((r) => `${r.source}=${r._count._all}`).join(', ');
    console.log(`  #${fsId} (db=${c.ticketId}) status=${c.status} | ${summary}`);
  }

  // Also derive what the UI screenshot's "6 no thread context" actually were
  // by checking which IT cases in the run still have 0 conversation entries.
  console.log(`\nCases in this run with zero CONVERSATION entries (likely newly-created):`);
  let zeroConv = 0;
  for (const c of cases) {
    const cnt = await prisma.ticketThreadEntry.count({
      where: { ticketId: c.ticketId, source: 'freshservice_conversation' },
    });
    if (cnt === 0) {
      zeroConv += 1;
      const t = await prisma.ticket.findUnique({
        where: { id: c.ticketId },
        select: { freshserviceTicketId: true, subject: true, status: true, createdAt: true },
      });
      const ageH = ((Date.now() - new Date(t.createdAt)) / 3600000).toFixed(1);
      console.log(`  #${t.freshserviceTicketId} "${(t.subject || '').slice(0, 55)}" status=${t.status} age=${ageH}h`);
    }
  }
  console.log(`Total tickets with zero conversation entries: ${zeroConv}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
