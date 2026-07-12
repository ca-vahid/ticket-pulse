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
      this.processScheduled().catch((err) => logger.warn(`Scheduled-workflow sweep failed (non-fatal): ${err.message}`));
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

  /**
   * Scheduled (ticketless) workflows: fire once per configured slot in the
   * workspace timezone with a digest context. The run-level dedupe (stamp =
   * the slot itself) makes repeated ticks and the 60-min catch-up window
   * idempotent — a restart never double-sends and never misses a recent slot.
   */
  async processScheduled() {
    const CATCHUP_MINUTES = 60;
    const workflows = await prisma.notificationWorkflow.findMany({
      where: {
        isEnabled: true,
        archivedAt: null,
        publishedVersion: { gt: 0 },
        triggerType: 'schedule.time',
      },
      select: { id: true, workspaceId: true, publishedDefinition: true },
    });
    if (workflows.length === 0) return { scheduled: 0, fired: 0 };

    const workspaceIds = [...new Set(workflows.map((w) => w.workspaceId))];
    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: workspaceIds } },
      select: { id: true, name: true, defaultTimezone: true },
    });
    const workspaceById = new Map(workspaces.map((w) => [w.id, w]));

    let fired = 0;
    for (const workflow of workflows) {
      try {
        const workspace = workspaceById.get(workflow.workspaceId);
        if (!workspace) continue;
        const config = this._triggerConfig(workflow);
        const timezone = workspace.defaultTimezone || 'America/Los_Angeles';
        const nowInTz = zonedNowParts(timezone);
        const [hh, mm] = String(config.time || '08:00').split(':').map(Number);
        const slotMinutes = hh * 60 + mm;
        const frequency = config.frequency || 'daily';
        if (frequency === 'weekly' && nowInTz.weekday !== Number(config.weekday || 1)) continue;
        const sinceSlot = nowInTz.minutesOfDay - slotMinutes;
        if (sinceSlot < 0 || sinceSlot > CATCHUP_MINUTES) continue;

        const stamp = `schedule:${nowInTz.date}T${String(config.time || '08:00')}`;
        const digest = await this._digestFor(workflow.workspaceId);
        const eventContext = {
          event: {
            type: 'schedule.time',
            source: 'time_trigger',
            occurredAt: new Date().toISOString(),
            dedupeStamp: stamp,
            notificationFingerprint: `wf:${workflow.workspaceId}:schedule.time:${workflow.id}:${stamp}`,
          },
          workspace: { id: workspace.id, name: workspace.name, timezone },
          ticket: null,
          requester: null,
          assignedAgent: null,
          previousAgent: null,
          digest,
        };
        const { default: engine } = await import('./notificationWorkflowEngine.js');
        const result = await engine.executeForEvent(eventContext, {
          triggerSource: 'time_trigger',
          onlyWorkflowId: workflow.id,
        });
        if (result?.status === 'completed' && (result.workflowCount || 0) > 0) fired += 1;
      } catch (err) {
        logger.warn(`Scheduled workflow ${workflow.id} failed (non-fatal): ${err.message}`);
      }
    }
    return { scheduled: workflows.length, fired };
  }

  /** Workspace digest stats for scheduled emails ({{ digest.* }} in templates). */
  async _digestFor(workspaceId) {
    const now = new Date();
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
    const openWhere = { workspaceId, status: { in: OPEN_STATUSES }, isNoise: false };
    const [openCount, unassignedCount, overdueCount, dueTodayCount, oldest] = await Promise.all([
      prisma.ticket.count({ where: openWhere }),
      prisma.ticket.count({ where: { ...openWhere, assignedTechId: null } }),
      prisma.ticket.count({ where: { ...openWhere, dueBy: { lt: now } } }),
      prisma.ticket.count({ where: { ...openWhere, dueBy: { gte: now, lte: endOfDay } } }),
      prisma.ticket.findMany({
        where: openWhere,
        orderBy: { createdAt: 'asc' },
        take: 8,
        select: {
          id: true, subject: true, status: true, createdAt: true,
          nativeNumber: true, freshserviceTicketId: true, origin: true,
          assignedTech: { select: { name: true } },
        },
      }),
    ]);
    return {
      openCount,
      unassignedCount,
      overdueCount,
      dueTodayCount,
      oldestOpen: oldest.map((t) => ({
        ref: t.origin === 'ticketpulse' && t.nativeNumber ? `TP-${t.nativeNumber}` : `#${t.freshserviceTicketId || t.id}`,
        subject: t.subject || '(no subject)',
        status: t.status,
        assignee: t.assignedTech?.name || 'Unassigned',
        ageDays: Math.floor((now.getTime() - new Date(t.createdAt).getTime()) / 86400000),
      })),
    };
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

    // SLA triggers fire for Open tickets only — Pending pauses the clock, so
    // pre-breach/breach nags must not chase tickets waiting on the requester.
    // The generic aging trigger keeps Open+Pending (workflows legitimately
    // target "pending too long" with it).
    const slaTrigger = workflow.triggerType !== 'ticket.aging';
    const tickets = await prisma.ticket.findMany({
      where: {
        workspaceId: workflow.workspaceId,
        status: slaTrigger ? 'Open' : { in: OPEN_STATUSES },
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

/** Current wall-clock parts in an IANA timezone (no date libraries needed). */
function zonedNowParts(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  // Intl can render midnight as "24" in some environments — normalize.
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: hour * 60 + Number(get('minute')),
    weekday: weekdayIndex,
  };
}

const notificationTimeTriggerService = new NotificationTimeTriggerService();
export default notificationTimeTriggerService;
