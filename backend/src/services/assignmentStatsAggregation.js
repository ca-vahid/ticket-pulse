/**
 * Pure aggregation helpers for the auto-assign empty-state stats panel.
 * Kept separate from assignmentDailyStats.js so tests don't transitively
 * import Prisma (Jest's experimental ESM loader chokes on it).
 */

/**
 * Collapse a Prisma `groupBy(['status', 'decision'])` result into the stat
 * buckets we surface in the empty-state panel. Returns counts BEFORE the
 * handled-in-FS subtraction (that requires a separate query in the caller).
 *
 * @param {Array<{status: string, decision: string|null, _count: {_all: number}}>} grouped
 * @returns {{totalRuns:number, autoAssigned:number, approved:number, noiseDismissed:number, manualReviewRequired:number, inProgress:number, queuedForLater:number}}
 */
export function tallyGroupedRuns(grouped) {
  const tally = {
    totalRuns: 0,
    autoAssigned: 0,
    approved: 0,
    noiseDismissed: 0,
    manualReviewRequired: 0,
    inProgress: 0,
    queuedForLater: 0,
  };
  for (const row of grouped || []) {
    const n = row?._count?._all ?? 0;
    if (!Number.isFinite(n) || n <= 0) continue;
    tally.totalRuns += n;
    if (row.status === 'running') {
      tally.inProgress += n;
    } else if (row.status === 'queued') {
      tally.queuedForLater += n;
    } else if (row.status === 'completed') {
      switch (row.decision) {
      case 'auto_assigned': tally.autoAssigned += n; break;
      case 'approved':
      case 'modified': tally.approved += n; break;
      case 'noise_dismissed': tally.noiseDismissed += n; break;
      case 'pending_review': tally.manualReviewRequired += n; break;
      default: break;
      }
    }
  }
  return tally;
}

/**
 * Subtract the handled-in-FS count from manualReviewRequired so the buckets
 * don't double-count. handled-in-FS is a UI label that maps to a SUBSET of
 * pending_review runs (those whose ticket has assignedTechId set), so it
 * needs its own query and post-adjustment.
 *
 * @param {{manualReviewRequired:number}} tally  Result of tallyGroupedRuns
 * @param {number} handledInFs
 * @returns {{manualReviewRequired:number}}  Mutated tally for chaining
 */
export function adjustForHandledInFs(tally, handledInFs) {
  tally.manualReviewRequired = Math.max(0, (tally.manualReviewRequired || 0) - (handledInFs || 0));
  return tally;
}
