/**
 * Auto-help → workflow triggers (integration W3, plans/AUTO_HELP_INTEGRATION_PLAN.md D).
 *
 *   auto_help.staged          an answer is waiting on the ticket for an agent
 *   auto_help.answered        the answer went out (agent click, or auto later)
 *   auto_help.nudged          the check-in went out
 *   auto_help.help_requested  the requester still needs a person
 *   auto_help.resolved        closed after silence or a confirmed fix
 *
 * Fire-and-forget through the one event door (ticketLifecycleNotificationService
 * .emitTicketEvent), so these reach workflows and webhooks like any ticket
 * event. The dedupe stamp is per run + event (+ a step key), so a retried
 * step never runs a workflow twice. Never throws.
 */
import logger from '../utils/logger.js';

export const AUTO_HELP_EVENT_TYPES = Object.freeze([
  'auto_help.staged',
  'auto_help.answered',
  'auto_help.nudged',
  'auto_help.help_requested',
  'auto_help.resolved',
]);

let emitterOverride = null;
/** Tests: capture events instead of dispatching them (null restores the real door). */
export function setAutoHelpEventEmitter(fn) {
  emitterOverride = typeof fn === 'function' ? fn : null;
}

export function emitAutoHelpEvent(type, ticketId, extra = {}, { stepKey = null } = {}) {
  if (!AUTO_HELP_EVENT_TYPES.includes(type) || !Number(ticketId)) return false;
  const runId = extra?.runId ?? 'none';
  const dedupeStamp = `${type}:${Number(ticketId)}:${runId}${stepKey ? `:${stepKey}` : ''}`;
  const payload = { source: 'auto_help', dedupeStamp, extra: { ...(extra || {}) } };
  try {
    if (emitterOverride) {
      Promise.resolve(emitterOverride(type, Number(ticketId), payload)).catch(() => {});
      return true;
    }
    import('./ticketLifecycleNotificationService.js')
      .then(({ emitTicketEvent }) => emitTicketEvent(type, Number(ticketId), payload))
      .catch((err) => logger.warn(`Auto-help event ${type} not dispatched for ticket ${ticketId}: ${err.message}`));
    return true;
  } catch (err) {
    logger.warn(`Auto-help event ${type} not dispatched for ticket ${ticketId}: ${err.message}`);
    return false;
  }
}

export default { AUTO_HELP_EVENT_TYPES, emitAutoHelpEvent, setAutoHelpEventEmitter };
