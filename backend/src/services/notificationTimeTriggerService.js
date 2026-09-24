import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import { TIME_TRIGGER_EVENT_TYPES } from './notificationWorkflowDefinition.js';
import { emitTicketEvent } from './ticketLifecycleNotificationService.js';

const TICK_INTERVAL_MS = Number(process.env.NOTIFICATION_TIME_TRIGGER_INTERVAL_MS) || 5 * 60 * 1000;
const MAX_TICKETS_PER_WORKFLOW_TICK = 200;
// Phase 8b: status scopes resolve per workspace through the registry —
// CRITICAL for custom statuses: a ticket sitting in an Open-base custom
// status ("In triage") must keep its SLA pre-breach/breach triggers alive,
// and a Pending-base one must keep aging. Every scan below is already
// per-workflow (which carries workspaceId), so the lookup is per-workspace
// by construction and served from the 60s statusService cache.
// Task due reminders (QA 08-04 #8b): the longest "notify before" preset bounds
// the scan's look-ahead; the grace window lets a reminder that elapsed while
// the worker was down still go out up to 60 minutes PAST the due time (same
// catch-up budget processScheduled uses) — "it's due / just came due" is still
// actionable then, while a stale "due soon" hours later would be noise.
const TASK_REMINDER_MAX_MINUTES = 120;
const TASK_REMINDER_GRACE_MINUTES = 60;
const MAX_TASK_REMINDERS_PER_TICK = 200;

/**
 * Time-based workflow triggers: ticket.aging / ticket.unassigned_for /
 * ticket.sla_pre_breach / ticket.sla_breach. Event workflows fire when
 * something HAPPENS; these fire when something DOESN'T (nobody picked the
 * ticket up, nobody resolved it, the SLA clock ran down).
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
      this.scanTaskReminders().catch((err) => logger.warn(`Task-reminder scan failed (non-fatal): ${err.message}`));
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
    const openWhere = {
      workspaceId,
      status: { in: await statusService.statusNamesForBase(workspaceId, ['Open', 'Pending']) },
      isNoise: false,
      parkedUntil: null, // parked tickets wait on purpose
    };
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

  /**
   * Task due reminders (QA 08-04 #8b) — same 5-minute cadence as the SLA
   * pre-breach trigger, same idempotency shape (a per-row stamp instead of the
   * engine's dedupe): tasks with a due time, a notify-before setting, an
   * assignee, and no reminder sent yet get an email once `now >= dueAt −
   * remindBeforeMinutes`, up to TASK_REMINDER_GRACE_MINUTES past due.
   *
   * Only TP-owned rows (origin='ticketpulse') are scanned — FS-born/shadow
   * rows carry FreshService's own notify_before and FS owns notifications
   * there (see ticketTaskService.sendDueReminder for the full rule).
   */
  async scanTaskReminders() {
    if (!this.isEnabled()) return { skipped: true };
    const now = new Date();
    const candidates = await prisma.ticketTask.findMany({
      where: {
        origin: 'ticketpulse',
        status: { not: 'done' },
        // An unassigned task belongs to the ticket owner (Simorgh B7) — the
        // owner lookup happens in sendDueReminder.
        remindBeforeMinutes: { not: null },
        reminderSentAt: null,
        // Widest possible window: earliest interesting dueAt is grace-minutes
        // ago; latest is the longest preset ahead. The per-row threshold
        // (dueAt − remindBeforeMinutes) is checked below.
        dueAt: {
          gte: new Date(now.getTime() - TASK_REMINDER_GRACE_MINUTES * 60 * 1000),
          lte: new Date(now.getTime() + TASK_REMINDER_MAX_MINUTES * 60 * 1000),
        },
      },
      select: {
        id: true, title: true, description: true, status: true, origin: true,
        dueAt: true, remindBeforeMinutes: true, reminderSentAt: true,
        assignedTech: { select: { id: true, name: true, email: true } },
        ticket: { select: { id: true, workspaceId: true, origin: true, subject: true, nativeNumber: true, freshserviceTicketId: true, assignedTech: { select: { id: true, name: true, email: true } } } },
      },
      orderBy: { dueAt: 'asc' },
      take: MAX_TASK_REMINDERS_PER_TICK,
    });

    let sent = 0;
    if (candidates.length > 0) {
      const { default: ticketTaskService } = await import('./ticketTaskService.js');
      for (const task of candidates) {
        const remindAt = new Date(task.dueAt).getTime() - task.remindBeforeMinutes * 60 * 1000;
        if (now.getTime() < remindAt) continue; // not inside its window yet
        try {
          if (await ticketTaskService.sendDueReminder(task)) sent += 1;
        } catch (err) {
          logger.warn(`Task reminder for task ${task.id} failed (non-fatal): ${err.message}`);
        }
      }
    }
    return { candidates: candidates.length, sent };
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

  /**
   * Stamp each candidate with `unassignedSince` and drop the ones that were
   * released more recently than the threshold. ONE grouped query for the
   * whole batch (<= MAX_TICKETS_PER_WORKFLOW_TICK ids), not one per ticket.
   * A partial/absent activity table degrades to createdAt rather than
   * silencing the trigger.
   */
  async _withUnassignedSince(tickets, cutoff) {
    if (tickets.length === 0) return tickets;
    let latestByTicket = new Map();
    try {
      const rows = await Promise.resolve().then(() => prisma.ticketActivity.groupBy({
        by: ['ticketId'],
        where: { ticketId: { in: tickets.map((t) => t.id) }, activityType: 'assigned' },
        _max: { performedAt: true },
      }));
      latestByTicket = new Map((rows || []).map((r) => [r.ticketId, r._max?.performedAt]).filter(([, at]) => at));
    } catch (err) {
      logger.warn(`Unassigned-since lookup failed, falling back to createdAt (non-fatal): ${err.message}`);
    }
    const out = [];
    for (const ticket of tickets) {
      const released = latestByTicket.get(ticket.id);
      const since = released && new Date(released) > new Date(ticket.createdAt)
        ? new Date(released)
        : new Date(ticket.createdAt);
      if (since <= cutoff) out.push({ ...ticket, unassignedSince: since });
    }
    return out;
  }

  /**
   * QA 09-18 #5 — "the requester has gone quiet". One indexed query per
   * workflow per tick: tickets in the chosen statuses whose LATEST public
   * message is an agent's and older than N hours. The dedupe stamp is that
   * agent message's id, so a workflow fires once per agent reply: a newer
   * agent reply restarts the clock, a requester reply stops it (the latest
   * message is theirs, so the ticket drops out of the scan). Nothing is
   * parked, nothing polls per ticket — FreshService's supervisor rule without
   * the supervisor.
   *
   * Trigger config: silentHours (default 72), statusBase 'Pending' (default)
   * | 'Open' | 'any' (both), statuses [] (explicit names win over the base).
   */
  async _processRequesterSilent(workflow, config, now) {
    const silentHours = Math.max(1, Number(config.silentHours) || 72);
    const cutoff = new Date(now.getTime() - silentHours * 3600 * 1000);
    const explicit = (Array.isArray(config.statuses) ? config.statuses : []).map((s) => String(s || '').trim()).filter(Boolean);
    const base = config.statusBase === 'Open' ? 'Open' : config.statusBase === 'any' ? ['Open', 'Pending'] : 'Pending';
    const statuses = explicit.length ? explicit : await statusService.statusNamesForBase(workflow.workspaceId, base);
    const { requesterSilentCandidates } = await import('./ticketReplyClockService.js');
    const found = await requesterSilentCandidates(workflow.workspaceId, { statuses, cutoff, limit: MAX_TICKETS_PER_WORKFLOW_TICK });
    const candidates = await this._dueByClock(workflow.workspaceId, config.clock, found, silentHours, (c) => new Date(c.lastAgentReplyAt), now);
    let dispatched = 0;
    for (const c of candidates) {
      const result = await emitTicketEvent(workflow.triggerType, c.ticketId, {
        source: 'time_trigger',
        dedupeStamp: `silent:${silentHours}h:${c.lastAgentEntryId}`,
        extra: {
          thresholdHours: silentHours,
          lastAgentReplyAt: new Date(c.lastAgentReplyAt).toISOString(),
          silentForMs: now.getTime() - new Date(c.lastAgentReplyAt).getTime(),
        },
        onlyWorkflowId: workflow.id,
      });
      if (result?.status === 'completed' && (result.workflowCount || 0) > 0) dispatched += 1;
    }
    return dispatched;
  }

  /**
   * QA 09-21 #5/#8: a trigger can count only business time. `clock` on the
   * trigger node: 'always' (default, wall clock) | 'business_hours' (only the
   * hours inside the workspace's Business Hours) | 'business_days' (24 h per
   * working day, weekends and holidays skipped). The 24/7 cutoff stays as the
   * DB pre-filter (business time never elapses faster than wall time); this
   * drops the candidates whose business deadline is still ahead. One loaded
   * calendar per workflow; no calendar rows → wall clock, like the SLA clocks.
   */
  async _dueByClock(workspaceId, clock, items, hours, sinceOf, now = new Date()) {
    const mode = clock === 'business_hours' || clock === 'business_days' ? clock : 'always';
    if (mode === 'always' || !items.length) return items;
    let calendar = null;
    try {
      const { default: businessCalendarService } = await import('./businessCalendarService.js');
      calendar = await businessCalendarService.loadCalendar(workspaceId);
      if (!calendar) return items; // no business hours configured → wall clock
      const minutes = Math.max(1, Number(hours) || 1) * 60;
      const out = [];
      for (const item of items) {
        const since = sinceOf(item);
        const deadline = mode === 'business_hours'
          ? await businessCalendarService.addBusinessMinutes(since, minutes, { workspaceId, calendar })
          : await businessCalendarService.addBusinessDayMinutes(since, minutes, { workspaceId, calendar });
        if (deadline <= now) out.push(item);
      }
      return out;
    } catch (err) {
      logger.warn(`Time trigger business clock failed, using wall clock (non-fatal): ${err.message}`);
      return items;
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
    let unassignedCutoff = null;
    if (workflow.triggerType === 'ticket.aging') {
      const agingHours = Math.max(1, Number(config.agingHours) || 24);
      const cutoff = new Date(now.getTime() - agingHours * 3600 * 1000);
      where = { createdAt: { lte: cutoff } };
      stampFor = (t) => `aging:${agingHours}h:${t.id}`;
      extraFor = (t) => ({ thresholdHours: agingHours, ticketAgeMs: now.getTime() - new Date(t.createdAt).getTime() });
    } else if (workflow.triggerType === 'ticket.unassigned_for') {
      // FR 09-17 #2 — "nobody picked this up". The clock starts when the
      // ticket was last LEFT unassigned, which is the newest 'assigned'
      // activity (ticketService._audit writes one with toTechId null when a
      // ticket is released) and otherwise the creation time. Releasing a
      // ticket therefore re-arms the trigger instead of replaying the
      // original stamp.
      const unassignedHours = Math.max(1, Number(config.unassignedHours) || 4);
      const cutoff = new Date(now.getTime() - unassignedHours * 3600 * 1000);
      where = { assignedTechId: null, createdAt: { lte: cutoff } };
      unassignedCutoff = cutoff;
      stampFor = (t) => `unassigned:${unassignedHours}h:${new Date(t.unassignedSince).toISOString()}`;
      extraFor = (t) => ({
        thresholdHours: unassignedHours,
        unassignedSince: new Date(t.unassignedSince).toISOString(),
        unassignedForMs: now.getTime() - new Date(t.unassignedSince).getTime(),
      });
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
    } else if (workflow.triggerType === 'ticket.requester_silent_for') {
      return this._processRequesterSilent(workflow, config, now);
    } else {
      return 0;
    }

    // SLA triggers fire for Open-BASE tickets only — Pending-base statuses
    // pause the clock, so pre-breach/breach nags must not chase tickets
    // waiting on the requester. The generic aging trigger keeps Open+Pending
    // bases (workflows legitimately target "pending too long" with it).
    // Unassigned scans Open-base only for the same reason: a ticket parked on
    // the requester is not waiting for someone to pick it up.
    const slaTrigger = workflow.triggerType !== 'ticket.aging';
    const scanStatuses = await statusService.statusNamesForBase(
      workflow.workspaceId,
      slaTrigger ? 'Open' : ['Open', 'Pending'],
    );
    let tickets = await prisma.ticket.findMany({
      where: {
        workspaceId: workflow.workspaceId,
        status: { in: scanStatuses },
        isNoise: false,
        // Parked tickets wait on purpose: no aging / unassigned / SLA nags.
        parkedUntil: null,
        ...where,
      },
      select: { id: true, createdAt: true, dueBy: true },
      orderBy: { id: 'asc' },
      take: MAX_TICKETS_PER_WORKFLOW_TICK,
    });

    if (unassignedCutoff) {
      tickets = await this._withUnassignedSince(tickets, unassignedCutoff);
    }
    if (workflow.triggerType === 'ticket.aging') {
      tickets = await this._dueByClock(workflow.workspaceId, config.clock, tickets, Number(config.agingHours) || 24, (t) => new Date(t.createdAt), now);
    } else if (workflow.triggerType === 'ticket.unassigned_for') {
      tickets = await this._dueByClock(workflow.workspaceId, config.clock, tickets, Number(config.unassignedHours) || 4, (t) => new Date(t.unassignedSince), now);
    }

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
