/**
 * What happens after a requester reply, once the workflows (the reopen one in
 * particular) have had their turn (13 Oct 2026). Called from one place:
 * emitTicketEvent('ticket.reply_received'), which every reply path goes
 * through exactly once per reply (mailbox ingest, FreshService conversation
 * sync, mirror pull-back), each with a stable per-reply stamp.
 *
 *  1. Owner away      → clear the owner, send the ticket back for assignment.
 *  2. New request?    → suggest splitting the reply into its own ticket.
 *
 * Both are per-workspace switches (requesterReplyRulesService) and both are
 * no-ops for a FreshService system line (survey response) or an agent's own
 * reply. Never throws: a reply is always recorded whatever happens here.
 */
import logger from '../utils/logger.js';

/**
 * @param {object} p
 * @param {object} p.before      the ticket as hydrated BEFORE the workflows ran
 * @param {string|null} p.statusBaseBefore  its base status then (Open / Pending / Resolved / Closed)
 * @param {string|null} p.stamp  the reply's dedupe stamp
 * @param {object|null} p.extra  the event's extra
 */
export async function afterRequesterReplyEvent({ before, statusBaseBefore = null, stamp = null, extra = null } = {}) {
  const out = { ownerAway: null, newRequest: null };
  if (!before?.id || !before?.workspaceId) return out;
  if (extra?.isSurveyResponse === true || extra?.senderIsAgent === true) return out;

  try {
    const { default: ownerAwayRerouteService } = await import('./ownerAwayRerouteService.js');
    out.ownerAway = await ownerAwayRerouteService.afterRequesterReply(before.id, before.workspaceId, { replyStamp: stamp });
  } catch (err) {
    logger.warn(`Owner-away follow-up skipped for ticket ${before.id}: ${err.message}`);
  }

  try {
    const { default: newRequestSuggestionService } = await import('./newRequestSuggestionService.js');
    out.newRequest = await newRequestSuggestionService.afterRequesterReply({
      before: {
        id: before.id,
        workspaceId: before.workspaceId,
        status: before.status,
        statusBase: statusBaseBefore,
        resolvedAt: before.resolvedAt || null,
        closedAt: before.closedAt || null,
      },
      replyStamp: stamp,
      extra: extra || {},
    });
  } catch (err) {
    logger.warn(`New-request follow-up skipped for ticket ${before.id}: ${err.message}`);
  }
  return out;
}

export default { afterRequesterReplyEvent };
