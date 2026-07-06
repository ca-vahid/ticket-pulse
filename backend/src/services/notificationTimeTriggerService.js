import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { TIME_TRIGGER_EVENT_TYPES } from './notificationWorkflowDefinition.js';
import { emitTicketEvent } from './ticketLifecycleNotificationService.js';

const TICK_INTERVAL_MS = Number(process.env.NOTIFICATION_TIME_TRIGGER_INTERVAL_MS) || 5 * 60 * 1000;
const MAX_TICKETS_PER_WORKFLOW_TICK = 200;
const OPEN_STATUSES = ['Open', 'Pending'];

/**
 * Time-based workflow triggers: ticket.aging / ticket.sla_pre_breach /
 * ticket.sla_breach. Event workflows fire when something HAPPENS; these fire
 * when something DOESN'T (nobody resolved the ticket, the SLA clock ran down).
 *
 * Same start/stop worker pattern as mirrorService. Each tick scans candidate
 * tickets per enabled time-trigger workflow and dispatches through
 * emitTicketEvent with `onlyWorkflowId` — thresholds (agingHours,
 * preBreachMinutes) are per-workflow trigger-node config, so a shared event
 * type must not fan out to sibling workflows with different thresholds.
 *
 * Idempotency: dedupe stamps are stable per (ticket, threshold[, dueBy]), so
 * the engine's run-level dedupe fires each workflow once per ticket per
 * threshold crossing. A dueBy change re-arms the SLA triggers (correct — the
 * deadline moved). Republishing a workflow re-arms everything (dedupe keys
 * include the version); documented behavior.
 */
class NotificationTimeTriggerService {
  constructor() {
    this._timer = null;
    this._ticking = false;
  }

  isEnabled() {
    return process.env.NOTIFICATION_TIME_TRIGGERS_ENABLED !== 'false';
  }

  start() {
    if (this._timer || !this.isEnabled()) return;
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.warn(`Time-trigger tick failed (non-fatal): ${err.message}`));
      this.resumeDueRuns().catch(() => {});
    }, TICK_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Notification time-trigger worker started (every ${Math.round(TICK_INTERVAL_MS / 1000)}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._ticking || !this.isEnabled()) return { skipped: true };
    this._ticking = true;
    try {
      const workflows = await prisma.notificationWorkflow.findMany({
        where: {
          isEnabled: true,
          archivedAt: null,
          publishedVersion: { gt: 0 },
          triggerType: { in: TIME_TRIGGER_EVENT_TYPES },
        },
        select: {
          id: true,
          workspaceId: true,
          triggerType: true,
          publishedDefinition: true,
        },
      });
      if (workflows.length === 0) return { workflows: 0, dispatched: 0 };

      let dispatched = 0;
      for (const workflow of workflows) {
        try {
          dispatched += await this._processWorkflow(workflow);
        } catch (err) {
          logger.warn(`Time-trigger workflow ${workflow.id} failed (non-fatal): ${err.message}`);
        }
      }
      return { workflows: workflows.length, dispatched };
    } finally {
      this._ticking = false;
    }
  }

  /** Delay-node resume rides the same tick cadence as the time triggers. */
  async resumeDueRuns() {
    try {
      const { resumeWaitingRuns } = await import('./notificationWorkflowEngine.js');
      return await resumeWaitingRuns();
    } catch (err) {
      logger.warn(`Workflow delay-resume sweep failed (non-fatal): ${err.message}`);
      return { due: 0, resumed: 0 };
    }
  }

  _triggerConfig(workflow) {
    const nodes = workflow.publishedDefinition?.nodes || [];
    const trigger = nodes.find((n) => n.type === 'trigger');
    return trigger?.data || {};
  }

  async _processWorkflow(workflow) {
    const config = this._triggerConfig(workflow);
    const now = new Date();

    let where;
    let stampFor;
    let extraFor;
    if (workflow.triggerType === 'ticket.aging') {
      const agingHours = Math.max(1, Number(config.agingHours) || 24);
      const cutoff = new Date(now.getTime() - agingHours * 3600 * 1000);
      where = { createdAt: { lte: cutoff } };
      stampFor = (t) => `aging:${agingHours}h:${t.id}`;
      extraFor = (t) => ({ thresholdHours: agingHours, ticketAgeMs: now.getTime() - new Date(t.createdAt).getTime() });
    } else if (workflow.triggerType === 'ticket.sla_pre_breach') {
      const preBreachMinutes = Math.max(5, Number(config.preBreachMinutes) || 60);
      const horizon = new Date(now.getTime() + preBreachMinutes * 60 * 1000);
      where = { dueBy: { gt: now, lte: horizon } };
      stampFor = (t) => `sla_pre:${preBreachMinutes}m:${new Date(t.dueBy).toISOString()}`;
      extraFor = (t) => ({ preBreachMinutes, dueBy: new Date(t.dueBy).toISOString() });
    } else if (workflow.triggerType === 'ticket.sla_breach') {
      where = { dueBy: { lt: now } };
      stampFor = (t) => `sla_breach:${new Date(t.dueBy).toISOString()}`;
      extraFor = (t) => ({ dueBy: new Date(t.dueBy).toISOString() });
    } else {
      return 0;
    }

    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId: workflow.workspaceId,
        status: { in: OPEN_STATUSES },
        isNoise: false,
        ...where,
      },
      select: { id: true, createdAt: true, dueBy: true },
      orderBy: { id: 'asc' },
      take: MAX_TICKETS_PER_WORKFLOW_TICK,
    });

    let dispatched = 0;
    for (const ticket of tickets) {
      // The engine's run-level dedupe (workflow+version+event+ticket+stamp)
      // makes repeated ticks cheap no-ops for already-fired tickets.
      const result = await emitTicketEvent(workflow.triggerType, ticket.id, {
        source: 'time_trigger',
        dedupeStamp: stampFor(ticket),
        extra: extraFor(ticket),
        onlyWorkflowId: workflow.id,
      });
      if (result?.status === 'completed' && (result.workflowCount || 0) > 0) dispatched += 1;
    }
    return dispatched;
  }
}

const notificationTimeTriggerService = new NotificationTimeTriggerService();
export default notificationTimeTriggerService;
