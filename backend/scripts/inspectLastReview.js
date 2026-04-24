/**
 * Inspect the most recent assignment_daily_review_runs row, including its
 * timing, status, progress payload, warnings, and the per-ticket thread
 * coverage so we can see what the LLM actually had vs what's missing.
 */
import prisma from '../src/services/prisma.js';

const wsArg = process.argv[2] ? Number(process.argv[2]) : null;

async function inspect(workspaceId) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId }, select: { id: true, name: true },
  });
  if (!ws) return;

  const run = await prisma.assignmentDailyReviewRun.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      createdAt: true,
      completedAt: true,
      totalDurationMs: true,
      totalTokensUsed: true,
      errorMessage: true,
      reviewDate: true,
      timezone: true,
      warnings: true,
      progress: true,
      progressUpdatedAt: true,
      summaryMetrics: true,
      analyzedTicketIds: true,
      evidenceCases: true,
    },
  });

  if (!run) {
    console.log(`\nws=${workspaceId} (${ws.name}): no daily review runs found`);
    return;
  }

  const elapsedMs = run.totalDurationMs
    ?? (run.completedAt ? new Date(run.completedAt) - new Date(run.createdAt) : null);
  const elapsedMin = elapsedMs ? (elapsedMs / 60000).toFixed(2) : null;

  console.log(`\n=== ws=${workspaceId} (${ws.name}) — run #${run.id} ===`);
  console.log(`status:        ${run.status}`);
  console.log(`reviewDate:    ${run.reviewDate}`);
  console.log(`createdAt:     ${run.createdAt}`);
  console.log(`completedAt:   ${run.completedAt}`);
  console.log(`elapsed:       ${elapsedMin ? `${elapsedMin} min` : '(not done)'}`);
  console.log(`tokensUsed:    ${run.totalTokensUsed ?? '(none)'}`);
  console.log(`errorMessage:  ${run.errorMessage || '(none)'}`);
  console.log(`progressUpd:   ${run.progressUpdatedAt}`);

  if (run.progress) {
    console.log(`progress.phase:       ${run.progress.phase || '?'}`);
    console.log(`progress.percent:     ${run.progress.percent || '?'}%`);
    console.log(`progress.message:     ${run.progress.message?.slice(0, 200) || '(none)'}`);
    if (run.progress.stats) {
      console.log(`progress.stats:       ${JSON.stringify(run.progress.stats).slice(0, 300)}`);
    }
  }

  console.log(`warnings:      ${(run.warnings || []).length}`);
  for (const w of (run.warnings || []).slice(0, 8)) {
    console.log(`  - ${w.slice(0, 220)}`);
  }

  // Cohort thread coverage — per case, how many activity + conversation rows
  // are cached locally. This tells us exactly which tickets reached the LLM
  // with no thread context (the screenshot shows 6 such tickets).
  const cases = Array.isArray(run.evidenceCases) ? run.evidenceCases : [];
  console.log(`\nevidenceCases: ${cases.length}`);

  if (cases.length > 0) {
    const caseTicketIds = cases.map((c) => c.ticketId).filter(Boolean);
    const counts = await prisma.ticketThreadEntry.groupBy({
      by: ['ticketId', 'source'],
      where: { workspaceId, ticketId: { in: caseTicketIds } },
      _count: { _all: true },
    });
    const byTicket = new Map();
    for (const r of counts) {
      const cur = byTicket.get(r.ticketId) || { activities: 0, conversations: 0 };
      if (r.source === 'freshservice_conversation') cur.conversations = r._count._all;
      else cur.activities = r._count._all;
      byTicket.set(r.ticketId, cur);
    }

    let zeroBoth = 0;
    let withDescOnly = 0;
    let fullyEnriched = 0;
    const noContextSamples = [];
    for (const c of cases) {
      const cnt = byTicket.get(c.ticketId) || { activities: 0, conversations: 0 };
      const hasDesc = !!c.descriptionText;
      if (cnt.activities === 0 && cnt.conversations === 0) {
        zeroBoth += 1;
        if (hasDesc && noContextSamples.length < 6) {
          noContextSamples.push({
            fsId: c.freshserviceTicketId,
            subject: c.subject?.slice(0, 70),
            descLen: c.descriptionText.length,
            requester: c.requester?.name,
          });
        }
        if (hasDesc) withDescOnly += 1;
      } else {
        fullyEnriched += 1;
      }
    }

    console.log(`  fully enriched (act>0 OR conv>0):   ${fullyEnriched}`);
    console.log(`  zero thread context (LLM blind):    ${zeroBoth}`);
    console.log(`    of those, with descriptionText:   ${withDescOnly}`);
    if (noContextSamples.length > 0) {
      console.log(`  samples with no thread context:`);
      for (const s of noContextSamples) {
        console.log(`    #${s.fsId} "${s.subject}" desc=${s.descLen}ch req=${s.requester}`);
      }
    }
  }
}

async function main() {
  const list = wsArg
    ? [{ id: wsArg }]
    : await prisma.workspace.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
  for (const w of list) {
    try { await inspect(w.id); } catch (e) {
      console.error(`ws=${w.id}: failed`, e.message);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
