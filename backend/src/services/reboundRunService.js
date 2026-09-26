import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Shared rebound-run creation (extracted from syncService._handleTicketRebound
 * for QA 09-25 item 3): one pipeline run per rejection EVENT, whether the
 * return was seen in FreshService activity (FS-born) or done in Ticket Pulse
 * (TP-born hand-back).
 *
 * Guards (unchanged from the sync path):
 *  - assignment pipeline must be enabled for the workspace
 *  - ONE run per rejection event (dedupe on reboundFrom.unassignedAt)
 *  - no run while another is queued/running for the ticket
 *  - past MAX_AUTO_REBOUNDS_PER_TICKET distinct returns, park ONE
 *    "needs manual review" run instead of auto-rerouting forever
 * Observe-only / business-hours handling stays inside runPipeline.
 */
export const MAX_AUTO_REBOUNDS_PER_TICKET = 3;

/**
 * @param {object} args
 * @param {number} args.ticketId
 * @param {number} args.workspaceId
 * @param {object} args.reboundFrom   { previousTechId, previousTechName, unassignedAt (ISO), unassignedByName, reboundCount, reason?, ... }
 * @param {string} args.returnedPhrase  honest one-liner for the exhausted narrative
 * @param {(run: {id:number}) => void} [args.onRun]  called with the run once known
 * @returns {Promise<{ outcome: string, runId?: number }>}
 */
export async function queueReboundRun({ ticketId, workspaceId, reboundFrom, returnedPhrase, onRun = null, freshserviceTicketId = null, prechecked = false }) {
  const rejectionKey = reboundFrom?.unassignedAt;
  if (!rejectionKey) return { outcome: 'no_event_key' };

  const { default: assignmentRepository } = await import('./assignmentRepository.js');
  if (!prechecked) {
    const pre = await reboundPrecheck({ ticketId, workspaceId, rejectionKey, assignmentRepository });
    if (pre) return pre;
  }

  const openRun = await assignmentRepository.getOpenPipelineRun(ticketId);
  if (openRun) {
    logger.debug('Bounce detection: in-flight run already exists, skipping', {
      ticketId, existingRunId: openRun.id, status: openRun.status,
    });
    return { outcome: 'open_run_exists', runId: openRun.id };
  }
  return createReboundRun({ ticketId, workspaceId, reboundFrom, returnedPhrase, onRun, freshserviceTicketId });
}

/**
 * Cheap early exits (pipeline off, event already handled). Returns null when
 * the caller should go on; otherwise the outcome. The sync path runs this
 * BEFORE its heavier lookups because the rebound STATE stays true every pass.
 */
export async function reboundPrecheck({ ticketId, workspaceId, rejectionKey, assignmentRepository = null }) {
  const repo = assignmentRepository || (await import('./assignmentRepository.js')).default;
  const cfg = await repo.getConfig(workspaceId);
  if (!cfg?.isEnabled) return { outcome: 'pipeline_disabled' };

  // ONE run per rejection event: a prior run carrying this exact event
  // timestamp (any status — superseded, approved, exhausted) means this is a
  // re-detection, not a new bounce.
  const alreadyHandled = await prisma.assignmentPipelineRun.findFirst({
    where: {
      ticketId,
      reboundFrom: { path: ['unassignedAt'], equals: rejectionKey },
    },
    select: { id: true, status: true, triggerSource: true },
  });
  if (alreadyHandled) {
    logger.debug('Bounce detection: rejection event already handled, skipping re-detection', {
      ticketId, existingRunId: alreadyHandled.id, rejectionKey,
    });
    return { outcome: 'already_handled', runId: alreadyHandled.id };
  }
  return null;
}

async function createReboundRun({ ticketId, workspaceId, reboundFrom, returnedPhrase, onRun, freshserviceTicketId }) {
  const rejectionCount = reboundFrom.reboundCount || 1;
  if (rejectionCount > MAX_AUTO_REBOUNDS_PER_TICKET) {
    const existingExhausted = await prisma.assignmentPipelineRun.findFirst({
      where: {
        ticketId,
        triggerSource: 'rebound_exhausted',
        status: 'completed',
        decision: 'pending_review',
      },
      select: { id: true },
    });
    if (existingExhausted) {
      logger.debug('Bounce detection: an exhausted run is already awaiting review, skipping', {
        ticketId, existingRunId: existingExhausted.id,
      });
      return { outcome: 'exhausted_pending', runId: existingExhausted.id };
    }

    logger.warn('Bounce detection: max auto-rebounds reached, materializing pending_review run', {
      ticketId, rejectionCount,
    });
    try {
      const reasonLine = reboundFrom.reason?.label
        ? ` Reason given on the latest return: ${reboundFrom.reason.label}${reboundFrom.reason.note ? ` — "${reboundFrom.reason.note}"` : ''}.`
        : '';
      const run = await prisma.assignmentPipelineRun.create({
        data: {
          ticketId,
          workspaceId,
          status: 'completed',
          decision: 'pending_review',
          triggerSource: 'rebound_exhausted',
          errorMessage: `Returned to the queue ${rejectionCount} times — automatic re-routing stopped; assign manually`,
          reboundFrom,
          // Synthesized empty recommendation so the Awaiting Decision UI
          // renders this as a "no candidates left to try" run.
          recommendation: {
            recommendations: [],
            overallReasoning: `${returnedPhrase}. This ticket has been returned to the queue ${rejectionCount} times — past the automatic re-routing limit of ${MAX_AUTO_REBOUNDS_PER_TICKET} — so no further automatic assignment will happen. Assign it manually or dismiss.${reasonLine}`,
            ticketClassification: 'needs_manual_review',
            confidence: 'low',
          },
        },
      });
      if (run?.id) onRun?.(run);
      return { outcome: 'exhausted', runId: run?.id };
    } catch (err) {
      logger.error('Bounce detection: failed to materialize rebound_exhausted run', {
        ticketId, error: err.message,
      });
      return { outcome: 'failed' };
    }
  }

  // Supersede stale pending_review runs (they likely name the agent who just
  // returned it) so the ticket shows up once in Awaiting Decision.
  const superseded = await prisma.assignmentPipelineRun.updateMany({
    where: { ticketId, status: 'completed', decision: 'pending_review' },
    data: {
      status: 'superseded',
      errorMessage: 'Superseded by a newer rebound run after ticket was returned to the queue',
      updatedAt: new Date(),
    },
  });
  if (superseded.count > 0) {
    logger.info('Bounce detection: superseded prior pending_review runs', { ticketId, count: superseded.count });
  }

  logger.info('Bounce detection: queueing rebound pipeline run', {
    ticketId,
    freshserviceTicketId: freshserviceTicketId?.toString?.() || null,
    ...reboundFrom,
  });

  // runPipeline queues (outside business hours) or runs now; not awaited.
  const { default: assignmentPipelineService } = await import('./assignmentPipelineService.js');
  assignmentPipelineService.runPipeline(ticketId, workspaceId, 'rebound', null, null, { reboundFrom })
    .then((result) => {
      const runId = result?.id || result?.runId || null;
      if (runId) onRun?.({ id: runId });
    })
    .catch((err) => {
      logger.warn('Rebound pipeline trigger failed', { ticketId, error: err.message });
    });
  return { outcome: 'queued' };
}

export default { queueReboundRun, reboundPrecheck, MAX_AUTO_REBOUNDS_PER_TICKET };
