import prisma from './prisma.js';
import { tallyGroupedRuns, adjustForHandledInFs } from './assignmentStatsAggregation.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Aggregate the last 24 hours of pipeline activity for a workspace, used by
 * the Review Queue's auto-assign empty-state panel.
 *
 * IMPORTANT — window choice:
 * Originally this used a workspace-tz "today" window (midnight to midnight in
 * the workspace's local timezone). That made the counts disagree with the
 * destination tabs whenever a row created late yesterday Pacific was visible
 * in the rolling-24h destination but excluded by today's calendar bounds.
 * The user reported "card says 0 but the tab shows 3" exactly because of
 * this. The fix is to use the same rolling-24h window the destination tabs
 * use — that way clicking a card always lands on a tab whose count matches.
 *
 * The empty state header label was renamed from "TODAY" to "LAST 24H" to
 * reflect this honestly.
 *
 * Pure-ish: takes Prisma + tz, returns a plain object. Nothing in here
 * mutates state.
 *
 * @param {number} workspaceId
 * @param {string} timezone     IANA zone for the workspace (kept on the
 *                              response so the UI can format times correctly,
 *                              but no longer used to anchor the window).
 * @returns {Promise<{
 *   range: { start: string, end: string, timezone: string, label: string },
 *   totalRuns: number,
 *   autoAssigned: number,
 *   approved: number,
 *   handledInFs: number,
 *   noiseDismissed: number,
 *   manualReviewRequired: number,
 *   inProgress: number,
 *   queuedForLater: number,
 *   rebounds: number,
 *   noiseFiltered: number,
 *   pipelineBypass: number,
 *   recentAutoAssignments: Array<{ runId: number, ticketSubject: string, ticketId: number, freshserviceTicketId: string|null, techName: string|null, techPhotoUrl: string|null, decidedAt: string }>,
 *   recentRebounds: Array<object>,
 *   recentBypassed: Array<object>,
 *   recentNoiseFiltered: Array<object>,
 * }>}
 */
export async function getTodayStats(workspaceId, timezone) {
  const end = new Date();
  const start = new Date(end.getTime() - TWENTY_FOUR_HOURS_MS);

  // One grouped query for outcome counts. createdAt bounds the window;
  // updatedAt would let stale "running" runs from days ago count today,
  // which is wrong.
  const grouped = await prisma.assignmentPipelineRun.groupBy({
    by: ['status', 'decision'],
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
    },
    _count: { _all: true },
  });

  const tally = tallyGroupedRuns(grouped);

  // "Handled in FS" — pipeline runs that completed as pending_review BUT
  // whose ticket later got an assignedTechId (the agent grabbed it in FS
  // before the admin could review). Identical filters + window as the
  // "Manually in FreshService" sub-tab so the count matches exactly.
  const handledInFs = await prisma.assignmentPipelineRun.count({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      status: 'completed',
      decision: 'pending_review',
      ticket: { is: { assignedTechId: { not: null } } },
    },
  });
  adjustForHandledInFs(tally, handledInFs);

  // Pipeline-bypass — tickets that arrived in the last 24h and got assigned
  // in FS entirely outside our system (no pipeline run created at all,
  // usually because the agent grabbed it in the ~30s window before our next
  // poll). Surfaced as a separate pill so it doesn't conflate with handledInFs.
  const [assignedTodayCount, pipelineSeenTicketIds] = await Promise.all([
    prisma.ticket.count({
      where: {
        workspaceId,
        createdAt: { gte: start, lte: end },
        assignedTechId: { not: null },
      },
    }),
    prisma.assignmentPipelineRun.findMany({
      where: {
        workspaceId,
        createdAt: { gte: start, lte: end },
      },
      select: { ticketId: true },
      distinct: ['ticketId'],
    }),
  ]);
  const pipelineBypass = Math.max(0, assignedTodayCount - pipelineSeenTicketIds.length);

  // "Noise filtered" — tickets we deliberately skipped because a noise rule
  // matched. Surfacing this lets the admin see WHY some tickets aren't being
  // auto-assigned (silently dying in the noise filter looks like a bug).
  const noiseFiltered = await prisma.ticket.count({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      isNoise: true,
    },
  });

  // Rebound activity in the window. Counts any run whose triggerSource is
  // rebound* OR whose reboundFrom metadata is set — covers both fresh
  // rebound runs and edge cases where metadata was attached but the trigger
  // source label drifted. Useful because the "in progress" tile is a
  // snapshot that misses brief rebound runs (LLM finishes in 30-60s); a
  // 24h count persists across refreshes so the admin sees rebounds happened.
  const reboundRows = await prisma.assignmentPipelineRun.findMany({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      OR: [
        { triggerSource: { in: ['rebound', 'rebound_exhausted'] } },
        { reboundFrom: { not: null } },
      ],
    },
    select: { ticketId: true },
    distinct: ['ticketId'],
  });
  const rebounds = reboundRows.length;

  // Last 10 auto-assignments — feeds the recent activity feed at the bottom
  // of the empty state. Was previously a single "most recent" row; expanded
  // so the admin can see the AI's recent batch at a glance.
  const recentRuns = await prisma.assignmentPipelineRun.findMany({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      decision: 'auto_assigned',
      assignedTechId: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      updatedAt: true,
      ticket: { select: { id: true, subject: true, freshserviceTicketId: true } },
      assignedTech: { select: { name: true, photoUrl: true } },
    },
  });

  // Ticket-list previews for the clickable process-state pills. Each capped
  // at 20 rows so the modal stays scannable. These power the modal that
  // opens when the admin clicks the "rebounds today" / "bypassed pipeline" /
  // "noise-filtered" pills — there's no existing destination tab for any
  // of these because they're not regular pipeline-run outcomes.
  const [recentRebounds, recentBypassed, recentNoiseFilteredTickets] = await Promise.all([
    prisma.assignmentPipelineRun.findMany({
      where: {
        workspaceId,
        createdAt: { gte: start, lte: end },
        OR: [
          { triggerSource: { in: ['rebound', 'rebound_exhausted'] } },
          { reboundFrom: { not: null } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        ticketId: true,
        createdAt: true,
        triggerSource: true,
        reboundFrom: true,
        ticket: { select: { id: true, subject: true, freshserviceTicketId: true } },
        assignedTech: { select: { name: true, photoUrl: true } },
      },
    }),
    // Bypassed: created today, now assigned, no pipeline run exists.
    // Find candidates then filter out anything with a run.
    (async () => {
      const candidates = await prisma.ticket.findMany({
        where: {
          workspaceId,
          createdAt: { gte: start, lte: end },
          assignedTechId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          subject: true,
          freshserviceTicketId: true,
          createdAt: true,
          assignedTech: { select: { name: true, photoUrl: true } },
          pipelineRuns: { select: { id: true }, take: 1 },
        },
      });
      return candidates
        .filter((t) => !t.pipelineRuns || t.pipelineRuns.length === 0)
        .slice(0, 20)
        .map(({ pipelineRuns: _ignore, ...t }) => t);
    })(),
    prisma.ticket.findMany({
      where: {
        workspaceId,
        createdAt: { gte: start, lte: end },
        isNoise: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        subject: true,
        freshserviceTicketId: true,
        createdAt: true,
        noiseRuleMatched: true,
        requester: { select: { name: true } },
      },
    }),
  ]);

  return {
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
      timezone,
      label: 'Last 24h',
    },
    totalRuns: tally.totalRuns,
    autoAssigned: tally.autoAssigned,
    approved: tally.approved,
    handledInFs,
    noiseDismissed: tally.noiseDismissed,
    manualReviewRequired: tally.manualReviewRequired,
    inProgress: tally.inProgress,
    queuedForLater: tally.queuedForLater,
    rebounds,
    noiseFiltered,
    pipelineBypass,
    recentAutoAssignments: recentRuns.map((r) => ({
      runId: r.id,
      ticketId: r.ticket?.id,
      ticketSubject: r.ticket?.subject || '(no subject)',
      freshserviceTicketId: r.ticket?.freshserviceTicketId
        ? String(r.ticket.freshserviceTicketId)
        : null,
      techName: r.assignedTech?.name || null,
      techPhotoUrl: r.assignedTech?.photoUrl || null,
      decidedAt: r.updatedAt.toISOString(),
    })),
    recentRebounds: Array.from(
      recentRebounds.reduce((map, run) => {
        if (!map.has(run.ticketId)) map.set(run.ticketId, run);
        return map;
      }, new Map()).values(),
    ).map((r) => ({
      runId: r.id,
      ticketId: r.ticket?.id,
      ticketSubject: r.ticket?.subject || '(no subject)',
      freshserviceTicketId: r.ticket?.freshserviceTicketId
        ? String(r.ticket.freshserviceTicketId)
        : null,
      techName: r.assignedTech?.name || null,
      techPhotoUrl: r.assignedTech?.photoUrl || null,
      triggerSource: r.triggerSource,
      reboundFromRunId: r.reboundFrom?.runId ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    recentBypassed: recentBypassed.map((t) => ({
      ticketId: t.id,
      ticketSubject: t.subject || '(no subject)',
      freshserviceTicketId: t.freshserviceTicketId ? String(t.freshserviceTicketId) : null,
      techName: t.assignedTech?.name || null,
      techPhotoUrl: t.assignedTech?.photoUrl || null,
      createdAt: t.createdAt.toISOString(),
    })),
    recentNoiseFiltered: recentNoiseFilteredTickets.map((t) => ({
      ticketId: t.id,
      ticketSubject: t.subject || '(no subject)',
      freshserviceTicketId: t.freshserviceTicketId ? String(t.freshserviceTicketId) : null,
      requesterName: t.requester?.name || null,
      noiseRuleMatched: t.noiseRuleMatched || null,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}
