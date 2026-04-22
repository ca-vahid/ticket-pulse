import prisma from './prisma.js';
import { getTodayRange } from '../utils/timezone.js';
import { tallyGroupedRuns, adjustForHandledInFs } from './assignmentStatsAggregation.js';

/**
 * Aggregate today's pipeline activity for a workspace, used by the Review
 * Queue's auto-assign empty-state panel. Returns counts of each decision
 * outcome plus a one-row preview of the most recent auto-assignment, so the
 * empty page has something interesting to show when auto-assign is doing
 * its job and the queue is genuinely empty.
 *
 * "Today" is bounded by the workspace timezone so the stats line up with
 * what the coordinator considers the current shift.
 *
 * Pure-ish: takes Prisma + tz, returns a plain object. Nothing in here
 * mutates state.
 *
 * @param {number} workspaceId
 * @param {string} timezone     IANA zone for the workspace
 * @returns {Promise<{
 *   range: { start: string, end: string, timezone: string },
 *   totalRuns: number,
 *   autoAssigned: number,
 *   approved: number,
 *   handledInFs: number,
 *   noiseDismissed: number,
 *   manualReviewRequired: number,
 *   inProgress: number,
 *   queuedForLater: number,
 *   rebounds: number,
 *   latestAutoAssignment: null | { runId: number, ticketSubject: string, ticketId: number, freshserviceTicketId: string|null, techName: string|null, decidedAt: string },
 * }>}
 */
export async function getTodayStats(workspaceId, timezone) {
  const { start, end } = getTodayRange(timezone);

  // One grouped query for outcome counts. createdAt bounds today's runs in
  // the workspace's local day window; updatedAt would let stale "running"
  // runs from yesterday count today, which is wrong.
  const grouped = await prisma.assignmentPipelineRun.groupBy({
    by: ['status', 'decision'],
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
    },
    _count: { _all: true },
  });

  const tally = tallyGroupedRuns(grouped);

  // "Handled in FS" is a UI label, not a stored decision — it's
  // pending_review runs whose ticket got picked up in FS directly. Count
  // separately so the empty state can surface "X tickets handled outside
  // the pipeline today" honestly.
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

  // Rebound activity: tickets that bounced back today and triggered a fresh
  // pipeline run (or hit the rebound_exhausted manual-review state). We
  // count any run whose triggerSource is rebound* OR whose reboundFrom
  // metadata is set — covers both fresh rebound runs and edge cases where
  // metadata was attached but the trigger source label drifted. Useful for
  // the empty-state panel because the "in progress" tile is a snapshot
  // that misses brief rebound runs (LLM finishes in 30-60s); a daily count
  // persists across refreshes so the admin sees rebounds happened.
  const rebounds = await prisma.assignmentPipelineRun.count({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      OR: [
        { triggerSource: { in: ['rebound', 'rebound_exhausted'] } },
        { reboundFrom: { not: null } },
      ],
    },
  });

  // Latest auto-assignment for the "AI just did this" preview. Best signal
  // that the system is alive and working when the queue page is empty.
  const latest = await prisma.assignmentPipelineRun.findFirst({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      decision: 'auto_assigned',
      assignedTechId: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      updatedAt: true,
      ticket: { select: { id: true, subject: true, freshserviceTicketId: true } },
      assignedTech: { select: { name: true } },
    },
  });

  return {
    range: {
      start: start.toISOString(),
      end: end.toISOString(),
      timezone,
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
    latestAutoAssignment: latest
      ? {
        runId: latest.id,
        ticketId: latest.ticket?.id,
        ticketSubject: latest.ticket?.subject || '(no subject)',
        freshserviceTicketId: latest.ticket?.freshserviceTicketId
          ? String(latest.ticket.freshserviceTicketId)
          : null,
        techName: latest.assignedTech?.name || null,
        decidedAt: latest.updatedAt.toISOString(),
      }
      : null,
  };
}
