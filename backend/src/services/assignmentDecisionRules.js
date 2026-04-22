/**
 * Pure helpers for the "should we auto-assign or downgrade to pending_review?"
 * decision logic. Extracted so unit tests can exercise the rules without
 * spinning up Prisma or the full pipeline service.
 */

/**
 * Check whether a ticket's FreshService group is excluded from auto-assignment.
 * When true, the LLM's recommendation should still be presented to the admin,
 * but the system should NOT auto-execute it — even with autoAssign=true.
 *
 * @param {bigint|number|null|undefined} ticketGroupId  The ticket's FS group_id (BigInt on Prisma side, may be null)
 * @param {Array<number>|null|undefined} excludedGroupIds  Workspace config — array of FS group IDs
 * @returns {boolean}
 */
export function isGroupExcluded(ticketGroupId, excludedGroupIds) {
  if (!ticketGroupId) return false;
  if (!Array.isArray(excludedGroupIds) || excludedGroupIds.length === 0) return false;
  // Normalize both sides to plain numbers. ticket.group_id is a Prisma BigInt
  // on the backend but the config column is INTEGER[], so a direct === would
  // miss every match without this coercion.
  const id = Number(ticketGroupId);
  if (!Number.isFinite(id)) return false;
  return excludedGroupIds.some((g) => Number(g) === id);
}

/**
 * Returns true when the pipeline itself finalized the decision (no admin in
 * the loop). Used by _executeRun to decide whether to stamp `decidedAt` on
 * the run — which is what makes the run visible in the Decided/Dismissed
 * tabs (they filter by sinceField='decidedAt').
 *
 * pending_review explicitly returns false: the run really is still pending
 * an admin decision and should keep decidedAt=null until /decide or
 * /dismiss is called.
 *
 * @param {string|null|undefined} decision
 * @returns {boolean}
 */
export function isPipelineFinalDecision(decision) {
  return decision === 'auto_assigned' || decision === 'noise_dismissed';
}
