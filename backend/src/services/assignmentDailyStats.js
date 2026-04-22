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
 *   noiseFiltered: number,
 *   latestAutoAssignment: null | { runId: number, ticketSubject: string, ticketId: number, freshserviceTicketId: string|null, techName: string|null, techPhotoUrl: string|null, decidedAt: string },
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

  // "Handled in FS" — count tickets that ended up assigned today WITHOUT
  // going through our pipeline (or where our pipeline returned pending_review
  // and the agent grabbed it in FS afterwards). The previous version only
  // counted pending_review runs with assignedTechId set, but missed the
  // common case where an agent grabs a ticket in FS within the 30s window
  // before our poll fires — those tickets never get a pipeline run at all.
  //
  // Definition: tickets created today that are now assigned, MINUS the ones
  // we successfully assigned via the pipeline (auto_assigned / approved /
  // modified). Whatever's left was handled outside the pipeline by FS.
  const [assignedTodayCount, pipelineDrivenAssignmentTicketIds] = await Promise.all([
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
        decision: { in: ['auto_assigned', 'approved', 'modified'] },
      },
      select: { ticketId: true },
      distinct: ['ticketId'],
    }),
  ]);
  const pipelineDrivenTicketCount = pipelineDrivenAssignmentTicketIds.length;
  const handledInFs = Math.max(0, assignedTodayCount - pipelineDrivenTicketCount);
  // Old query (pending_review + assignedTechId) drove the manualReviewRequired
  // adjustment; preserve that behaviour by computing the legacy count
  // separately just for the bucket-double-counting fix.
  const pendingReviewWithAssignee = await prisma.assignmentPipelineRun.count({
    where: {
      workspaceId,
      createdAt: { gte: start, lte: end },
      status: 'completed',
      decision: 'pending_review',
      ticket: { is: { assignedTechId: { not: null } } },
    },
  });
  adjustForHandledInFs(tally, pendingReviewWithAssignee);

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
      assignedTech: { select: { name: true, photoUrl: true } },
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
    noiseFiltered,
    latestAutoAssignment: latest
      ? {
        runId: latest.id,
        ticketId: latest.ticket?.id,
        ticketSubject: latest.ticket?.subject || '(no subject)',
        freshserviceTicketId: latest.ticket?.freshserviceTicketId
          ? String(latest.ticket.freshserviceTicketId)
          : null,
        techName: latest.assignedTech?.name || null,
        techPhotoUrl: latest.assignedTech?.photoUrl || null,
        decidedAt: latest.updatedAt.toISOString(),
      }
      : null,
  };
}
