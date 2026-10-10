import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { ticketDisplayRef } from '../../utils/ticketOrigin.js';
import businessCalendarService from '../businessCalendarService.js';
import ticketActivityRepository from '../ticketActivityRepository.js';
import settingsService, { soft } from './settingsService.js';
import onCallService from './onCallService.js';
import {
  LAYERS, PRIORITY_LABELS, UNDOABLE_ACTIONS,
  atWork, awayPhrase, localParts, minutesToTime, normalizeSettings, rankResponders, responderPhrase, sentenceFor, validateSettings,
} from './rules.js';

/**
 * Urgent response — the engine (plans/URGENT_RESPONSE_PLAN.md).
 *
 * The rule: an Urgent ticket always has an owner who is at work, and somebody
 * touches it within N minutes. Three layers, all deterministic:
 *   1. when assigning  — guardAutoAssignment(), called by the AI pipeline;
 *   2. when it becomes urgent — the sweep finds a ticket that entered scope
 *      while its owner is not at work and moves it (or only tells, when the
 *      owner was assigned by hand);
 *   3. if nobody touches it — a clock in business minutes: the people at work
 *      are told, then the ticket moves, at most maxMoves times, then the
 *      coordinator.
 *
 * The sweep is a RECONCILER, not event-driven: ten code paths can raise a
 * priority and most record no event, so every minute it looks at what is in
 * scope now and at the clocks that are running. One clock row per ticket
 * (urgent_response_clocks) is the whole state; every step first claims the
 * row with a guarded updateMany, and every notice carries a dedupe key, so a
 * crash or a restart cannot act twice.
 *
 * Shadow (mode 'observe'): everything is worked out and logged with
 * shadow = true; nothing is sent, nothing moves, and a clock ends after its
 * first "would have moved" row.
 *
 * Nothing here ever notifies the requester.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
/** Integration sandboxes: never swept. */
const SANDBOX_WORKSPACES = [6, 7, 8];
const TICKET_BATCH = 200;
const CLOCK_BATCH = 50;
const MAX_CLOCKS_PER_SWEEP = 200;
const MAX_MARKERS_PER_SWEEP = 500;
const MAX_BASELINE_PAGES = 25;
const MAX_MOVE_ATTEMPTS = 3;
const MAX_TECHNICIANS = 500;
const COVER_CHECK_EVERY_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const PREVIEW_ROWS = 2000;
const PREVIEW_CHUNK = 200;
const PREVIEW_THREAD_CHUNK = 50;

const ACTIVE_STATES = ['running', 'waiting'];
/** A stopped clock with one of these reasons does not start again while the owner stays the same. */
const NO_RESTART_REASONS = ['touched', 'undone', 'baseline', 'coordinator', 'shadow_done', 'moved', 'failed'];
const AGENT_EVENT_TYPES = ['reply', 'note', 'forward', 'public_reply', 'private_note'];
const FS_AGENT_EVENT_TYPES = ['public_reply', 'private_note', 'forward'];
const HAND_METHODS = ['coordinator_assigned', 'self_picked'];

/** Our own writes: never a touch, never "assigned by hand". */
const ACTOR = { name: 'Ticket Pulse (urgent response)', role: 'automation', actorKind: 'system' };

const STAT_KEYS = Object.freeze({
  redirected: 'redirected',
  held: 'held',
  moved: 'moved',
  told_owner_away: 'toldOwnerAway',
  team_told: 'teamTold',
  coordinator: 'coordinator',
  on_call_assigned: 'onCallAssigned',
  undone: 'undone',
});
/** `moved` is also split by layer: raiseMoved + clockMoved = moved. */
const emptyCounts = () => ({ ...Object.fromEntries(Object.values(STAT_KEYS).map((k) => [k, 0])), raiseMoved: 0, clockMoved: 0 });

const TECH_SELECT = {
  id: true, name: true, email: true, isActive: true, assignableOnly: true, origin: true, freshserviceId: true,
  timezone: true, workStartTime: true, workEndTime: true,
};
const LEAVE_SELECT = {
  technicianId: true, leaveDate: true, category: true, status: true, isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true,
};
const TICKET_SELECT = {
  id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true, priority: true,
  assessedPriorityId: true, assignedTechId: true, assignedAt: true, assignedBy: true, isSelfPicked: true, parkedUntil: true, groupId: true, internalGroupId: true,
  internalCategoryId: true, internalSubcategoryId: true, createdAt: true,
  requester: { select: { name: true, email: true } },
};

const lc = (v) => String(v ?? '').trim().toLowerCase();
const uniq = (list) => [...new Set(list)];
const who = (id, name) => (id === null || id === undefined ? null : { id, name: name || `Technician ${id}` });
const nameOf = (tech, id = null) => tech?.name || (id ? `Technician ${id}` : 'the owner');
const priorityWord = (p) => PRIORITY_LABELS[Number(p)] || 'Urgent';
const isPositiveId = (n) => Number.isInteger(n) && n > 0;
const away = (reason) => ({ atWork: false, reason, startsInMinutes: null, nextStartAt: null, nextStartLocal: null });

/** The priorities layers 2 and 3 watch. */
function scopeOf(settings) {
  return uniq([...(settings.raiseEnabled ? settings.raisePriorities : []), ...(settings.clockEnabled ? settings.clockPriorities : [])]);
}
const clockCovers = (settings, priority) => settings.clockEnabled && settings.clockPriorities.includes(priority);
const raiseCovers = (settings, priority) => settings.raiseEnabled && settings.raisePriorities.includes(priority);

/**
 * Is this thread entry an agent's work on the ticket?
 * FS-synced entries carry no authorType: there the event type says who wrote.
 * Nothing the requester or the system does counts, and neither do our own
 * writes (the pipeline's "[Ticket Pulse]" note, FreshService's echo of a move).
 */
export function threadEntryIsTouch(entry, { isOurs, requester, countsAsRealActivity }) {
  const author = lc(entry.authorType);
  const type = lc(entry.eventType);
  const actor = lc(entry.actorName);
  if (author === 'system' || author === 'requester') return false;
  if (actor.startsWith('ticket pulse')) return false;
  // Written in Ticket Pulse by a signed-in agent: a touch, even when that person's name is also the FreshService API key owner's.
  if (author === 'agent' && entry.source === 'ticketpulse_user') return AGENT_EVENT_TYPES.includes(type);
  if (isOurs(actor)) return false;
  if (String(entry.bodyText || entry.content || '').trimStart().startsWith('[Ticket Pulse]')) return false;
  // An agent answering from their own mailbox arrives as "incoming" but is stamped agent.
  if (author === 'agent') return AGENT_EVENT_TYPES.includes(type);
  if (type === 'customer_reply' || entry.incoming === true) return false;
  if (entry.source === 'freshservice_activity') {
    if (!actor || !countsAsRealActivity(entry)) return false;
    if (requester?.name && actor === requester.name) return false;
    if (requester?.email && lc(entry.actorEmail) === requester.email) return false;
    return true;
  }
  return FS_AGENT_EVENT_TYPES.includes(type);
}

class UrgentResponseService {
  constructor() {
    this._timer = null;
    this._running = false;
    /** workspaceId → when the on-call cover check last ran (it dedupes durably itself). */
    this._coverCheckedAt = new Map();
  }

  // ---- the worker ------------------------------------------------------------

  start() {
    if (this._timer || process.env.URGENT_RESPONSE_SWEEP_ENABLED === 'false') return;
    this._timer = setInterval(() => { this.sweep().catch((err) => logger.warn(`Urgent response sweep failed: ${err.message}`)); }, SWEEP_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Urgent response sweep started (every ${SWEEP_INTERVAL_MS / 1000}s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * One pass over every workspace whose mode is not off: baseline when asked,
   * evaluate the active clocks, then look for tickets that entered scope.
   * Sequential and bounded; never throws.
   */
  async sweep({ now = new Date() } = {}) {
    if (this._running) return { skipped: true };
    this._running = true;
    const out = { workspaces: 0, baselined: 0, started: 0, stopped: 0, told: 0, moved: 0, held: 0, failed: 0, errors: 0 };
    try {
      // null = the table could not be read: do nothing at all (never "every workspace is off").
      const rows = await soft(() => prisma.urgentResponseSettings.findMany({
        where: { mode: { in: ['observe', 'live'] }, workspaceId: { notIn: SANDBOX_WORKSPACES } },
        select: { workspaceId: true, mode: true, baselinedAt: true },
        orderBy: { workspaceId: 'asc' },
        take: 50,
      }), null);
      if (!rows) return out;

      // Clocks of a workspace that was switched off end here, so switching it on again starts clean.
      await soft(() => prisma.urgentResponseClock.updateMany({
        where: { state: { in: ACTIVE_STATES }, workspaceId: { notIn: rows.map((r) => r.workspaceId) } },
        data: { state: 'stopped', stoppedAt: now, stopReason: 'mode_off' },
      }));

      for (const row of rows) {
        out.workspaces += 1;
        try {
          await this._sweepWorkspace(row, now, out);
        } catch (err) {
          out.errors += 1;
          logger.warn(`Urgent response: sweep of workspace ${row.workspaceId} failed: ${err.message}`);
        }
      }
    } catch (err) {
      out.errors += 1;
      logger.warn(`Urgent response sweep failed: ${err.message}`);
    } finally {
      this._running = false;
    }
    return out;
  }

  async _sweepWorkspace(row, now, out) {
    const ws = row.workspaceId;
    await this._coverCheck(ws, now);
    const ctx = await this._context(ws, now, { mode: row.mode });
    ctx.openStatuses = await this._openStatuses(ws);
    if (!row.baselinedAt) out.baselined += await this._baseline(ctx);
    await this._forgetLeft(ctx);
    await this._evaluateClocks(ctx, out);
    await this._discover(ctx, out);
  }

  /** The on-call "needs cover" check, at most once an hour per workspace. Never throws. */
  async _coverCheck(workspaceId, now) {
    const last = this._coverCheckedAt.get(workspaceId) || 0;
    if (now.getTime() - last < COVER_CHECK_EVERY_MS && now.getTime() >= last) return;
    this._coverCheckedAt.set(workspaceId, now.getTime());
    try {
      await onCallService.dailyCoverCheck(workspaceId, now);
    } catch (err) {
      logger.warn(`Urgent response: cover check failed for workspace ${workspaceId}: ${err.message}`);
    }
  }

  // ---- shared reads ----------------------------------------------------------

  /**
   * Everything one pass needs about a workspace, read once: the saved settings
   * (never the suggested on-call order), the business calendar, the active
   * team with its leave. `mode` 'live' acts; anything else is Shadow.
   */
  async _context(workspaceId, now, { mode = null, settings = null, leaveFrom = null } = {}) {
    const ws = Number(workspaceId);
    const saved = settings || await settingsService.getSettings(ws, { suggest: false });
    const calendar = await soft(() => businessCalendarService.loadCalendar(ws), null);
    const timezone = calendar?.timezone || await settingsService.timezone(ws);
    const technicians = await soft(() => prisma.technician.findMany({
      where: { workspaceId: ws, isActive: true },
      select: TECH_SELECT,
      orderBy: { id: 'asc' },
      take: MAX_TECHNICIANS,
    }), []);
    const ctx = {
      workspaceId: ws,
      now,
      settings: saved,
      mode: mode || saved.mode,
      shadow: (mode || saved.mode) !== 'live',
      scope: scopeOf(saved),
      calendar,
      timezone,
      technicians,
      techById: new Map(technicians.map((t) => [t.id, t])),
      leavesByTech: new Map(),
      // atWork() looks two weeks ahead for "starts at …".
      leaveWindow: { gte: new Date((leaveFrom || now).getTime() - 2 * DAY_MS), lte: new Date(now.getTime() + 15 * DAY_MS) },
      isBusinessDay: calendar ? (dateStr, dayOfWeek) => calendar.byDay.has(dayOfWeek) && !calendar.isHolidayDate(dateStr) : undefined,
      openStatuses: null,
      serviceAccounts: null,
    };
    await this._loadLeaves(ctx, technicians.map((t) => t.id));
    return ctx;
  }

  async _loadLeaves(ctx, technicianIds) {
    const ids = technicianIds.filter((id) => !ctx.leavesByTech.has(id));
    if (!ids.length) return;
    for (const id of ids) ctx.leavesByTech.set(id, []);
    const rows = await soft(() => prisma.technicianLeave.findMany({
      where: { technicianId: { in: ids }, status: 'APPROVED', leaveDate: ctx.leaveWindow },
      select: LEAVE_SELECT,
      take: 5000,
    }), []);
    for (const row of rows) ctx.leavesByTech.get(row.technicianId)?.push(row);
  }

  /** A technician of the workspace by id — the active team from the context, anyone else read once. */
  async _person(ctx, technicianId) {
    const id = Number(technicianId);
    if (!isPositiveId(id)) return null;
    if (ctx.techById.has(id)) return ctx.techById.get(id);
    const row = await soft(() => prisma.technician.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: TECH_SELECT }), null);
    ctx.techById.set(id, row);
    if (row) await this._loadLeaves(ctx, [id]);
    return row;
  }

  /** rules.atWork() for a person at an instant, with the workspace's business days and their leave. */
  _state(ctx, tech, at = ctx.now, graceMinutes = 0) {
    if (!tech) return away('unknown');
    if (!tech.isActive && !tech.assignableOnly) return away('inactive');
    return atWork(tech, at, {
      leaves: ctx.leavesByTech.get(tech.id) || [],
      isBusinessDay: ctx.isBusinessDay,
      graceMinutes,
      leaveTimezone: ctx.timezone,
    });
  }

  /** The same definition of "open" as the workload counts of the AI's candidate list. */
  async _openStatuses(workspaceId) {
    const { openWorkloadStatuses } = await import('../assignmentTools.js');
    return openWorkloadStatuses(workspaceId);
  }

  /** Names our own writes carry in FreshService (the API key's owner) — lower case. */
  async _serviceAccounts(ctx) {
    if (ctx.serviceAccounts) return ctx.serviceAccounts;
    const names = await soft(async () => {
      const { default: settingsRepository } = await import('../settingsRepository.js');
      return settingsRepository.getServiceAccountNames();
    }, []);
    ctx.serviceAccounts = new Set((Array.isArray(names) ? names : []).map(lc).filter(Boolean));
    return ctx.serviceAccounts;
  }

  async _isOurs(ctx) {
    const accounts = await this._serviceAccounts(ctx);
    return (name) => {
      const n = lc(name);
      return n.startsWith('ticket pulse') || accounts.has(n);
    };
  }

  _inScopeWhere(ctx) {
    return {
      workspaceId: ctx.workspaceId,
      status: { in: ctx.openStatuses },
      priority: { in: ctx.scope },
      assignedTechId: { not: null },
      parkedUntil: null,
    };
  }

  // ---- baseline --------------------------------------------------------------

  /**
   * No flood on switch-on: every ticket in scope right now gets a stopped
   * clock ("seen, nothing to do"), then the settings row is stamped. A clock
   * that is already running in the current mode is left alone.
   */
  async _baseline(ctx) {
    const { now } = ctx;
    let total = 0;
    if (ctx.scope.length) {
      let cursor = 0;
      for (let page = 0; page < MAX_BASELINE_PAGES; page++) {
        const tickets = await prisma.ticket.findMany({
          where: { ...this._inScopeWhere(ctx), id: { gt: cursor } },
          select: { id: true, assignedTechId: true },
          orderBy: { id: 'asc' },
          take: TICKET_BATCH,
        });
        if (!tickets.length) break;
        const ids = tickets.map((t) => t.id);
        await prisma.urgentResponseClock.deleteMany({ where: { ticketId: { in: ids }, NOT: { state: { in: ACTIVE_STATES }, shadow: ctx.shadow } } });
        await prisma.urgentResponseClock.createMany({
          data: tickets.map((t) => ({
            ticketId: t.id, workspaceId: ctx.workspaceId, ownerTechnicianId: t.assignedTechId, state: 'stopped', startedAt: now, stoppedAt: now, stopReason: 'baseline', shadow: ctx.shadow,
          })),
          skipDuplicates: true,
        });
        total += tickets.length;
        cursor = ids[ids.length - 1];
        if (tickets.length < TICKET_BATCH) break;
      }
    }
    await prisma.urgentResponseSettings.updateMany({ where: { workspaceId: ctx.workspaceId, baselinedAt: null }, data: { baselinedAt: now } });
    logger.info(`Urgent response: baseline for workspace ${ctx.workspaceId}: ${total} ticket(s) already in scope left alone`);
    return total;
  }

  /**
   * A stopped clock is a marker: "seen, nothing more to do while it stays like
   * this". Once its ticket leaves scope (closed, priority lowered, parked,
   * unassigned) the marker goes, so coming back into scope is a new cycle even
   * with the same owner. Bounded; the newest markers first.
   */
  async _forgetLeft(ctx) {
    const markers = await soft(() => prisma.urgentResponseClock.findMany({
      where: { workspaceId: ctx.workspaceId, state: 'stopped' },
      select: { ticketId: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_MARKERS_PER_SWEEP,
    }), []);
    if (!markers.length) return 0;
    const ids = markers.map((m) => m.ticketId);
    const still = await prisma.ticket.findMany({ where: { ...this._inScopeWhere(ctx), id: { in: ids } }, select: { id: true }, take: ids.length });
    const keep = new Set(still.map((t) => t.id));
    const gone = ids.filter((id) => !keep.has(id));
    if (!gone.length) return 0;
    const { count } = await prisma.urgentResponseClock.deleteMany({ where: { ticketId: { in: gone }, workspaceId: ctx.workspaceId, state: 'stopped' } });
    return count;
  }

  // ---- clock rows ------------------------------------------------------------

  async _runningData(ctx, { ownerId, startedAt = ctx.now, moveCount = 0, chain = [] }) {
    const { clockNotifyMinutes, clockMoveMinutes } = ctx.settings;
    const opts = { workspaceId: ctx.workspaceId, calendar: ctx.calendar };
    return {
      ownerTechnicianId: ownerId,
      state: 'running',
      startedAt,
      notifyAt: await businessCalendarService.addBusinessMinutes(startedAt, clockNotifyMinutes, opts),
      moveAt: await businessCalendarService.addBusinessMinutes(startedAt, clockMoveMinutes, opts),
      notifiedAt: null,
      moveCount,
      chainTechnicianIds: chain,
      stoppedAt: null,
      stopReason: null,
      shadow: ctx.shadow,
    };
  }

  _waitingData(ctx, { ownerId, startedAt = ctx.now, notifyAt = null, moveAt = null, notifiedAt = null, moveCount = 0, chain = [] }) {
    return {
      ownerTechnicianId: ownerId, state: 'waiting', startedAt, notifyAt, moveAt, notifiedAt, moveCount, chainTechnicianIds: chain, stoppedAt: null, stopReason: null, shadow: ctx.shadow,
    };
  }

  _stoppedData(ctx, { ownerId, reason, startedAt = ctx.now, moveCount = 0, chain = [] }) {
    return {
      ownerTechnicianId: ownerId, state: 'stopped', startedAt, notifyAt: null, moveAt: null, notifiedAt: null, moveCount, chainTechnicianIds: chain, stoppedAt: ctx.now, stopReason: reason, shadow: ctx.shadow,
    };
  }

  /** The clock after a new cycle or a move: running when layer 3 covers the priority, else a stopped marker. */
  async _clockFor(ctx, ticket, { ownerId, moveCount = 0, chain = [], idleReason = 'baseline' }) {
    if (clockCovers(ctx.settings, ticket.priority)) return this._runningData(ctx, { ownerId, moveCount, chain });
    return this._stoppedData(ctx, { ownerId, reason: idleReason, moveCount, chain });
  }

  async _setClock(ctx, ticketId, data) {
    return prisma.urgentResponseClock.upsert({
      where: { ticketId },
      create: { ticketId, workspaceId: ctx.workspaceId, ...data },
      update: data,
    });
  }

  /** Guarded step on an active clock: true when this pass owns it. */
  async _claim(clock, data, extraWhere = {}) {
    const { count } = await prisma.urgentResponseClock.updateMany({
      where: { ticketId: clock.ticketId, state: clock.state, startedAt: clock.startedAt, ...extraWhere },
      data,
    });
    return count > 0;
  }

  // ---- the log ---------------------------------------------------------------

  /**
   * One action: the log row, the ticket activity (live rows about a ticket)
   * and a log line. Returns the row, 'duplicate' when the dedupe key already
   * exists (the action was done before a restart), null when it could not be
   * written. Never throws.
   */
  async _record(ctx, {
    ticket = null, layer, action, from = null, to = null, sentence, details = null, dedupeKey = null, priority = null, shadow = ctx.shadow, undoOfId = null,
  }) {
    const meta = { ticketId: ticket?.id ?? null, workspaceId: ctx.workspaceId, layer, action, shadow };
    let row;
    try {
      row = await prisma.urgentResponseAction.create({
        data: {
          workspaceId: ctx.workspaceId,
          ticketId: ticket?.id ?? null,
          layer,
          action,
          shadow,
          priority: priority ?? ticket?.priority ?? null,
          fromTechnicianId: from?.id ?? null,
          toTechnicianId: to?.id ?? null,
          fromName: from?.name ?? null,
          toName: to?.name ?? null,
          sentence,
          ...(details ? { details } : {}),
          dedupeKey,
          ...(undoOfId ? { undoOfId } : {}),
        },
      });
    } catch (err) {
      if (err?.code === 'P2002') return 'duplicate';
      logger.warn('Urgent response: writing the log row failed', { ...meta, error: err.message });
      return null;
    }
    if (action === 'failed') logger.warn(`Urgent response: ${sentence}`, meta);
    else logger.info(`Urgent response: ${sentence}`, meta);
    if (!shadow && ticket?.id) {
      await ticketActivityRepository.create({
        ticketId: ticket.id,
        activityType: 'urgent_response',
        performedBy: 'Ticket Pulse',
        performedAt: ctx.now,
        details: { sentence, layer, action, fromTechId: from?.id ?? null, toTechId: to?.id ?? null },
      }).catch(() => {});
    }
    return row;
  }

  /** The engine's notifier, imported lazily (it pulls in Teams, mail and Twilio; tests replace this loader). */
  async _notifier() {
    const { default: notifier } = await import('./notifier.js');
    return notifier;
  }

  /** Tell technicians on the workspace's channels. Shadow tells nobody. Never throws. */
  async _tell(ctx, { technicianIds, title, lines, ticket = null, refKey }) {
    if (ctx.shadow) return null;
    const ids = uniq((technicianIds || []).filter(isPositiveId));
    if (!ids.length) return null;
    try {
      const notifier = await this._notifier();
      return await notifier.tellPeople({
        workspaceId: ctx.workspaceId, technicianIds: ids, title, lines, ticket, refKey, channels: [...ctx.settings.notifyChannels], link: null,
      });
    } catch (err) {
      logger.warn(`Urgent response: notice failed (${refKey}): ${err.message}`);
      return null;
    }
  }

  _subjectLine(ticket) {
    const subject = String(ticket.subject || '').trim().slice(0, 140);
    return subject ? `${ticketDisplayRef(ticket)}: ${subject}` : ticketDisplayRef(ticket);
  }

  /** Who is told when a ticket sits untouched: the people at work (with the owner), its group, or the named people. */
  async _audience(ctx, ticket) {
    const { settings } = ctx;
    if (settings.notifyAudience === 'named' && settings.notifyTechnicianIds.length) return [...settings.notifyTechnicianIds];
    if (settings.notifyAudience === 'group') {
      const members = await this._groupMembers(ctx, ticket);
      if (members.length) return members;
    }
    const onShift = ctx.technicians.filter((t) => this._state(ctx, t).atWork).map((t) => t.id);
    return uniq([...onShift, ...(ticket.assignedTechId ? [ticket.assignedTechId] : [])]);
  }

  async _groupMembers(ctx, ticket) {
    let groupId = ticket.internalGroupId || null;
    if (!groupId && ticket.groupId !== null && ticket.groupId !== undefined) {
      const group = await soft(() => prisma.group.findFirst({ where: { workspaceId: ctx.workspaceId, freshserviceId: BigInt(ticket.groupId) }, select: { id: true } }), null);
      groupId = group?.id || null;
    }
    if (!groupId) return [];
    const rows = await soft(() => prisma.groupMember.findMany({ where: { groupId, workspaceId: ctx.workspaceId }, select: { technicianId: true }, take: 200 }), []);
    return uniq(rows.map((r) => r.technicianId));
  }

  /** The person told when nobody is at work: the named contact, else the coordinator, else nobody. */
  async _nobodyContact(ctx) {
    const id = ctx.settings.nobodyContactTechnicianId ?? ctx.settings.coordinatorTechnicianId ?? null;
    return id ? this._person(ctx, id) : null;
  }

  // ---- who assigned it, and has anybody touched it ---------------------------

  /**
   * Was the current owner assigned by a person? The pipeline's own run wins
   * (FreshService reports its write-back under the API key owner's name), then
   * the open assignment episode, then the flags on the ticket. Unknown counts
   * as by hand: telling is the careful choice.
   */
  async _assignedByHand(ctx, ticket) {
    const isOurs = await this._isOurs(ctx);
    const run = await soft(() => prisma.assignmentPipelineRun.findFirst({
      where: { ticketId: ticket.id, workspaceId: ctx.workspaceId },
      orderBy: { id: 'desc' },
      select: { decision: true, assignedTechId: true },
    }), null);
    if (run?.decision === 'auto_assigned' && run.assignedTechId === ticket.assignedTechId) return false;

    const episode = await soft(() => prisma.ticketAssignmentEpisode.findFirst({
      where: { ticketId: ticket.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { technicianId: true, startMethod: true, startAssignedByName: true },
    }), null);
    if (episode && episode.technicianId === ticket.assignedTechId) {
      if (episode.startMethod === 'workflow_assigned') return false;
      if (HAND_METHODS.includes(episode.startMethod)) return episode.startMethod === 'self_picked' || !isOurs(episode.startAssignedByName);
    }
    if (ticket.isSelfPicked) return true;
    if (ticket.assignedBy && isOurs(ticket.assignedBy)) return false;
    return true;
  }

  /**
   * Has any agent done anything on the ticket since `since`? A reply, a note,
   * a forward, a status or field change by a person. Nothing the requester or
   * the system does counts, and none of our own writes.
   * @returns {{ touched: boolean, kind?: string, by?: string|null, at?: Date }}
   */
  async _touchedSince(ctx, ticket, since) {
    const isOurs = await this._isOurs(ctx);
    const activities = await soft(() => prisma.ticketActivity.findMany({
      where: { ticketId: ticket.id, performedAt: { gt: since } },
      select: { id: true, activityType: true, performedBy: true, performedAt: true, details: true },
      orderBy: { performedAt: 'asc' },
      take: 50,
    }), []);
    const act = activities.find((a) => a.details?.actorKind === 'human' && !isOurs(a.performedBy));
    if (act) return { touched: true, kind: act.activityType, by: act.performedBy || null, at: act.performedAt };

    const entries = await soft(() => prisma.ticketThreadEntry.findMany({
      where: { ticketId: ticket.id, occurredAt: { gt: since } },
      select: {
        id: true, source: true, eventType: true, authorType: true, incoming: true, actorName: true, actorEmail: true, bodyText: true, content: true, occurredAt: true,
      },
      orderBy: { occurredAt: 'asc' },
      take: 50,
    }), []);
    if (!entries.length) return { touched: false };
    const { countsAsRealActivity } = await import('../ticketThreadRepository.js');
    const requester = { name: lc(ticket.requester?.name), email: lc(ticket.requester?.email) };
    const entry = entries.find((e) => threadEntryIsTouch(e, { isOurs, requester, countsAsRealActivity }));
    return entry ? { touched: true, kind: entry.eventType, by: entry.actorName || null, at: entry.occurredAt } : { touched: false };
  }

  // ---- picking and moving ----------------------------------------------------

  /**
   * The next owner, in the fixed order: at work, has the skill (subcategory,
   * then category), fewest open tickets, least recently given a ticket.
   * FreshService tickets can only go to people with a FreshService seat.
   * @param {{ exclude?: number[], now?: Date, graceMinutes?: number, ctx?: object }} opts
   *   `graceMinutes`: "starts within N minutes" counts as at work (layer 1 only).
   * @returns {{ chosen: object|null, ranked: object[], considered: object[] }}
   *   `ranked` = the people at work, best first (the move falls back down this list);
   *   `considered` = everyone looked at, with `why`.
   */
  async pickResponder(workspaceId, ticket, { exclude = [], now = new Date(), graceMinutes = 0, ctx = null } = {}) {
    const c = ctx || await this._context(workspaceId, now);
    const skip = new Set((exclude || []).map(Number));
    const fsBorn = ticket.origin !== 'ticketpulse';
    const team = c.technicians.filter((t) => t.isActive && !skip.has(t.id) && (!fsBorn || (t.freshserviceId && t.origin !== 'local')));
    if (!team.length) return { chosen: null, ranked: [], considered: [] };
    const ids = team.map((t) => t.id);

    const categoryIds = [ticket.internalSubcategoryId, ticket.internalCategoryId].map(Number).filter(isPositiveId);
    const skills = categoryIds.length ? await soft(() => prisma.technicianCompetency.findMany({
      where: { technicianId: { in: ids }, competencyCategoryId: { in: categoryIds } },
      select: { technicianId: true, competencyCategoryId: true },
      take: 2000,
    }), []) : [];
    const names = categoryIds.length ? await soft(() => prisma.competencyCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
      take: categoryIds.length,
    }), []) : [];
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    const skillOf = (id) => {
      const mine = skills.filter((s) => s.technicianId === id).map((s) => s.competencyCategoryId);
      if (ticket.internalSubcategoryId && mine.includes(Number(ticket.internalSubcategoryId))) return { skill: 'exact', skillName: nameById.get(Number(ticket.internalSubcategoryId)) || null };
      if (ticket.internalCategoryId && mine.includes(Number(ticket.internalCategoryId))) return { skill: 'category', skillName: nameById.get(Number(ticket.internalCategoryId)) || null };
      return { skill: 'none', skillName: null };
    };

    const openStatuses = c.openStatuses || (c.openStatuses = await this._openStatuses(c.workspaceId));
    const open = await soft(() => prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId: c.workspaceId, assignedTechId: { in: ids }, status: { in: openStatuses } },
      _count: { _all: true },
    }), []);
    const last = await soft(() => prisma.ticket.groupBy({
      by: ['assignedTechId'],
      where: { workspaceId: c.workspaceId, assignedTechId: { in: ids }, assignedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
      _max: { assignedAt: true },
    }), []);
    const openBy = new Map(open.map((g) => [g.assignedTechId, g._count?._all ?? 0]));
    const lastBy = new Map(last.map((g) => [g.assignedTechId, g._max?.assignedAt || null]));

    const considered = rankResponders(team.map((t) => {
      const state = this._state(c, t, now, graceMinutes);
      return {
        id: t.id,
        name: t.name,
        atWork: state.atWork,
        awayReason: state.atWork ? null : state.reason,
        ...skillOf(t.id),
        openTickets: openBy.get(t.id) || 0,
        lastAssignedAt: lastBy.get(t.id) || null,
      };
    }));
    const ranked = considered.filter((p) => p.atWork);
    return { chosen: ranked[0] || null, ranked, considered };
  }

  /**
   * Reassign, origin-aware exactly like a workflow's assign step: a Ticket
   * Pulse ticket directly, a FreshService ticket through the confirmed
   * write-back. Throws when the write is refused (group membership, FS busy…).
   */
  async moveTicket(ticket, toTech, { allowAssignableOnly = false } = {}) {
    const { default: ticketService } = await import('../ticketService.js');
    if (ticket.origin === 'ticketpulse') {
      await ticketService.assignTicket(ticket.id, ticket.workspaceId, toTech.id, { ...ACTOR }, { allowAssignableOnly });
      return { via: 'ticketpulse' };
    }
    await ticketService.updateFsTicket(ticket.id, ticket.workspaceId, { assignedTechId: toTech.id }, { ...ACTOR }, { allowAssignableOnly });
    return { via: 'freshservice_writeback' };
  }

  /** Try the people at work, best first, at most three. */
  async _moveWithFallback(ticket, ranked) {
    const attempts = [];
    for (const candidate of ranked.slice(0, MAX_MOVE_ATTEMPTS)) {
      try {
        const result = await this.moveTicket(ticket, candidate);
        return { moved: candidate, via: result.via, attempts };
      } catch (err) {
        attempts.push({ technicianId: candidate.id, name: candidate.name, error: String(err.message || err).slice(0, 300) });
        logger.warn('Urgent response: move failed, trying the next person', { ticketId: ticket.id, workspaceId: ticket.workspaceId, toTechId: candidate.id, error: err.message });
      }
    }
    return { moved: null, attempts };
  }

  /**
   * Move a ticket to the best person at work (the clock row is already
   * claimed by the caller). Shadow logs "would have moved" and ends the clock.
   */
  async _move(ctx, ticket, {
    layer, owner, ownerState, pick, moveCount = 0, chain = [], startedAt = ctx.now, minutes = null, becameAt = null, out,
  }) {
    const from = who(ticket.assignedTechId, nameOf(owner, ticket.assignedTechId));
    // The layer is part of the key: a raise move and the first clock move of the new owner share a start instant.
    const key = `${layer}:${ticket.id}:${new Date(startedAt).toISOString()}:moved`;
    const words = (to) => sentenceFor('moved', {
      shadow: ctx.shadow,
      layer,
      priority: ticket.priority,
      from: from.name,
      to: to.name,
      reason: awayPhrase(from.name, ownerState),
      becameAt,
      toWhy: responderPhrase(to.name, to),
      why: to.why,
      minutes,
    });
    const considered = pick.considered.slice(0, 10).map((p) => ({ id: p.id, name: p.name, why: p.why }));

    if (ctx.shadow) {
      const to = pick.chosen;
      await this._record(ctx, {
        ticket, layer, action: 'moved', from, to: who(to.id, to.name), sentence: words(to), details: { why: to.why, considered }, dedupeKey: key,
      });
      await this._setClock(ctx, ticket.id, this._stoppedData(ctx, { ownerId: ticket.assignedTechId, reason: 'shadow_done', startedAt, moveCount, chain }));
      out.moved += 1;
      return { moved: false, shadow: true };
    }

    const result = await this._moveWithFallback(ticket, pick.ranked);
    if (!result.moved) {
      await this._failed(ctx, ticket, { layer, from, attempts: result.attempts, startedAt, moveCount, chain, out });
      return { moved: false };
    }
    const to = result.moved;
    const sentence = words(to);
    const row = await this._record(ctx, {
      ticket, layer, action: 'moved', from, to: who(to.id, to.name), sentence, details: { why: to.why, via: result.via, considered, failedAttempts: result.attempts }, dedupeKey: key,
    });
    await this._setClock(ctx, ticket.id, await this._clockFor(ctx, ticket, {
      ownerId: to.id, moveCount: moveCount + 1, chain: uniq([...chain, ticket.assignedTechId]), idleReason: 'moved',
    }));
    out.moved += 1;
    await this._tell(ctx, {
      technicianIds: [from.id, to.id],
      title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)} moved to ${to.name}`,
      lines: [this._subjectLine(ticket), sentence],
      ticket,
      refKey: `urgent-moved:${ticket.id}:${row?.id || new Date(startedAt).getTime()}`,
    });
    return { moved: true, to };
  }

  /** Nobody could take it: log, tell the coordinator, and stop trying (a person decides). */
  async _failed(ctx, ticket, { layer, from, to = null, attempts, startedAt = ctx.now, moveCount = 0, chain = [], out, keepClock = false }) {
    const error = attempts[attempts.length - 1]?.error || 'nobody could take it';
    const sentence = sentenceFor('failed', { from: from?.name, to: to?.name, error });
    const row = await this._record(ctx, {
      ticket, layer, action: 'failed', from, to, sentence, details: { attempts }, dedupeKey: `clock:${ticket.id}:${new Date(startedAt).toISOString()}:failed`,
    });
    if (!keepClock) await this._setClock(ctx, ticket.id, this._stoppedData(ctx, { ownerId: ticket.assignedTechId, reason: 'failed', startedAt, moveCount, chain }));
    if (out) out.failed += 1;
    if (row && row !== 'duplicate' && ctx.settings.coordinatorTechnicianId) {
      await this._tell(ctx, {
        technicianIds: [ctx.settings.coordinatorTechnicianId],
        title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)} could not be moved`,
        lines: [this._subjectLine(ticket), sentence, 'It stays where it is until somebody moves it by hand.'],
        ticket,
        refKey: `urgent-failed:${ticket.id}:${row.id}`,
      });
    }
  }

  /**
   * Nobody is at work. `on_call`: the on-call person gets it and a text (when
   * they are on leave without cover, or cannot be resolved, it is held).
   * `hold`: it stays with its owner, the contact is told, and the clock waits
   * — every sweep looks again until somebody is at work.
   */
  async _nobodyAtWork(ctx, ticket, {
    layer, owner, startedAt = ctx.now, notifyAt = null, moveAt = null, notifiedAt = null, moveCount = 0, chain = [], out,
  }) {
    const { settings, now } = ctx;
    const from = who(ticket.assignedTechId, nameOf(owner, ticket.assignedTechId));
    const iso = new Date(startedAt).toISOString();
    const waiting = () => this._setClock(ctx, ticket.id, this._waitingData(ctx, {
      ownerId: ticket.assignedTechId, startedAt, notifyAt, moveAt, notifiedAt, moveCount, chain,
    }));

    let onCall = null;
    if (settings.nobodyMode === 'on_call') {
      const current = await soft(() => onCallService.current(ctx.workspaceId, now), null);
      if (current?.technician && !current.onLeaveNoCover) onCall = current.technician;
    }
    // The owner is the on-call person: it is already where this mode would put it.
    if (onCall && onCall.id === ticket.assignedTechId) {
      await waiting();
      return { outcome: 'waiting' };
    }

    if (onCall) {
      const to = who(onCall.id, onCall.name);
      const key = `clock:${ticket.id}:${iso}:on_call_assigned`;
      if (ctx.shadow) {
        await this._record(ctx, {
          ticket, layer, action: 'on_call_assigned', from, to, sentence: sentenceFor('on_call_assigned', { shadow: true, to: to.name, priority: ticket.priority }), dedupeKey: key,
        });
        await this._setClock(ctx, ticket.id, this._stoppedData(ctx, { ownerId: ticket.assignedTechId, reason: 'shadow_done', startedAt, moveCount, chain }));
        out.moved += 1;
        return { outcome: 'on_call', shadow: true };
      }
      let moved = false;
      try {
        await this.moveTicket(ticket, onCall);
        moved = true;
      } catch (err) {
        // Recorded, then held like any other night nobody can take it.
        await this._failed(ctx, ticket, {
          layer, from, to, attempts: [{ technicianId: onCall.id, name: onCall.name, error: String(err.message || err).slice(0, 300) }], startedAt, out, keepClock: true,
        });
      }
      if (moved) {
        const notifier = await soft(() => this._notifier(), null);
        const sms = notifier
          ? await notifier.textOnCall(onCall, `Ticket Pulse: ${priorityWord(ticket.priority)} ticket ${this._subjectLine(ticket)} is yours as the on-call person. Nobody is at work.`)
          : { sent: false, reason: 'send_failed' };
        const sentence = sentenceFor('on_call_assigned', { to: to.name, priority: ticket.priority, texted: sms?.sent === true });
        const row = await this._record(ctx, {
          ticket, layer, action: 'on_call_assigned', from, to, sentence, details: { sms: { sent: sms?.sent === true, reason: sms?.reason || null } }, dedupeKey: key,
        });
        await this._setClock(ctx, ticket.id, await this._clockFor(ctx, ticket, {
          ownerId: onCall.id, moveCount: moveCount + 1, chain: uniq([...chain, ticket.assignedTechId]), idleReason: 'moved',
        }));
        out.moved += 1;
        await this._tell(ctx, {
          technicianIds: [onCall.id, from.id],
          title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)} is with the on-call person, ${to.name}`,
          lines: [this._subjectLine(ticket), sentence],
          ticket,
          refKey: `urgent-on-call:${ticket.id}:${row?.id || iso}`,
        });
        return { outcome: 'on_call' };
      }
    }

    // Hold: claim the clock first, so a restart finds it waiting and the dedupe key keeps the notice to one.
    await waiting();
    const contact = await this._nobodyContact(ctx);
    const sentence = sentenceFor('held', {
      shadow: ctx.shadow, layer, priority: ticket.priority, from: from.name, contact: contact?.name || null, nobodyTold: !contact,
    });
    const row = await this._record(ctx, {
      ticket, layer, action: 'held', from, sentence, details: { contactTechnicianId: contact?.id ?? null }, dedupeKey: `clock:${ticket.id}:${iso}:held`,
    });
    if (row && row !== 'duplicate') {
      out.held += 1;
      if (contact) {
        await this._tell(ctx, {
          technicianIds: [contact.id],
          title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)}: nobody is at work`,
          lines: [this._subjectLine(ticket), sentence, 'It moves as soon as somebody is at work.'],
          ticket,
          refKey: `urgent-held:${ticket.id}:${row.id}`,
        });
      }
    }
    return { outcome: 'hold' };
  }

  // ---- layer 2: a ticket enters scope ----------------------------------------

  /** Tickets in scope whose clock says a new cycle starts (see _isNewCycle). */
  async _discover(ctx, out) {
    if (!ctx.scope.length) return;
    const tickets = await prisma.ticket.findMany({
      where: this._inScopeWhere(ctx),
      select: TICKET_SELECT,
      // A priority or owner change touches updatedAt, so what just entered scope comes first.
      orderBy: { updatedAt: 'desc' },
      take: TICKET_BATCH,
    });
    if (!tickets.length) return;
    const ids = tickets.map((t) => t.id);
    const clocks = await prisma.urgentResponseClock.findMany({ where: { ticketId: { in: ids } }, take: ids.length });
    const byId = new Map(clocks.map((c) => [c.ticketId, c]));
    for (const ticket of tickets) {
      if (!this._isNewCycle(ticket, byId.get(ticket.id))) continue;
      try {
        await this._startCycle(ctx, ticket, out);
      } catch (err) {
        out.errors += 1;
        logger.warn('Urgent response: starting the clock failed', { ticketId: ticket.id, workspaceId: ctx.workspaceId, error: err.message });
      }
    }
  }

  /**
   * A new cycle: no clock yet, a different owner than the clock knows, or a
   * clock that stopped for a reason that has passed (priority lowered and
   * raised again, parked and woken, closed and reopened…).
   */
  _isNewCycle(ticket, clock) {
    if (!clock) return true;
    if (clock.ownerTechnicianId !== ticket.assignedTechId) return true;
    if (clock.state !== 'stopped') return false;
    return !NO_RESTART_REASONS.includes(clock.stopReason);
  }

  async _startCycle(ctx, ticket, out) {
    const { settings, now } = ctx;
    const ownerId = ticket.assignedTechId;
    const owner = await this._person(ctx, ownerId);
    // "Starts within the grace minutes" is at work for the owner in every layer.
    const ownerState = this._state(ctx, owner, now, settings.assignGraceMinutes);

    if (ownerState.atWork || !raiseCovers(settings, ticket.priority)) {
      const data = await this._clockFor(ctx, ticket, { ownerId });
      await this._setClock(ctx, ticket.id, data);
      if (data.state === 'running') out.started += 1;
      return;
    }

    const iso = now.toISOString();
    const from = who(ownerId, nameOf(owner, ownerId));
    const byHand = settings.raiseManualAction === 'notify' && await this._assignedByHand(ctx, ticket);
    if (byHand) {
      // Tell only: the ticket stays, the clock still applies.
      const data = await this._clockFor(ctx, ticket, { ownerId });
      await this._setClock(ctx, ticket.id, data);
      if (data.state === 'running') out.started += 1;
      const sentence = sentenceFor('told_owner_away', { shadow: ctx.shadow, priority: ticket.priority, from: from.name });
      const row = await this._record(ctx, {
        ticket, layer: 'raise', action: 'told_owner_away', from, sentence, details: { reason: awayPhrase(from.name, ownerState) }, dedupeKey: `clock:${ticket.id}:${iso}:told_owner_away`,
      });
      if (row && row !== 'duplicate') {
        out.told += 1;
        let audience = (await this._audience(ctx, ticket)).filter((id) => id !== ownerId);
        // Nobody else to tell (the night, a holiday): the contact for "nobody at work".
        if (!audience.length) audience = [(await this._nobodyContact(ctx))?.id].filter(Boolean);
        await this._tell(ctx, {
          technicianIds: audience,
          title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)}: ${from.name} is away`,
          lines: [this._subjectLine(ticket), sentence, awayPhrase(from.name, ownerState)],
          ticket,
          refKey: `urgent-owner-away:${ticket.id}:${row.id}`,
        });
      }
      return;
    }

    const pick = await this.pickResponder(ctx.workspaceId, ticket, { exclude: [ownerId], now, ctx });
    const becameAt = minutesToTime(localParts(now, ctx.timezone).minutes);
    if (pick.chosen) {
      // Claim: a clock for the current owner, so a crash mid-move leaves layer 3 to finish the job.
      await this._setClock(ctx, ticket.id, await this._clockFor(ctx, ticket, { ownerId }));
      await this._move(ctx, ticket, { layer: 'raise', owner, ownerState, pick, becameAt, out });
      return;
    }
    await this._nobodyAtWork(ctx, ticket, { layer: 'raise', owner, out });
  }

  // ---- layer 3: the clock ----------------------------------------------------

  async _evaluateClocks(ctx, out) {
    let cursor = 0;
    for (let seen = 0; seen < MAX_CLOCKS_PER_SWEEP;) {
      const clocks = await prisma.urgentResponseClock.findMany({
        where: { workspaceId: ctx.workspaceId, state: { in: ACTIVE_STATES }, ticketId: { gt: cursor } },
        orderBy: { ticketId: 'asc' },
        take: CLOCK_BATCH,
      });
      if (!clocks.length) break;
      const ids = clocks.map((c) => c.ticketId);
      const tickets = await prisma.ticket.findMany({ where: { id: { in: ids }, workspaceId: ctx.workspaceId }, select: TICKET_SELECT, take: ids.length });
      const byId = new Map(tickets.map((t) => [t.id, t]));
      for (const clock of clocks) {
        try {
          await this._evaluateClock(ctx, clock, byId.get(clock.ticketId) || null, out);
        } catch (err) {
          out.errors += 1;
          logger.warn('Urgent response: evaluating the clock failed', { ticketId: clock.ticketId, workspaceId: ctx.workspaceId, error: err.message });
        }
      }
      cursor = ids[ids.length - 1];
      seen += clocks.length;
      if (clocks.length < CLOCK_BATCH) break;
    }
  }

  /** Why an active clock no longer applies, or null. */
  _leftScope(ctx, clock, ticket) {
    if (!ticket || !ctx.openStatuses.includes(ticket.status)) return 'closed';
    if (ticket.parkedUntil) return 'parked';
    if (!ticket.assignedTechId) return 'unassigned';
    if (ticket.assignedTechId !== clock.ownerTechnicianId) return 'owner_changed';
    const inScope = clock.state === 'waiting' ? ctx.scope.includes(ticket.priority) : clockCovers(ctx.settings, ticket.priority);
    return inScope ? null : 'priority_lowered';
  }

  async _evaluateClock(ctx, clock, ticket, out) {
    const { now } = ctx;
    const stop = async (reason) => {
      if (await this._claim(clock, { state: 'stopped', stoppedAt: now, stopReason: reason })) out.stopped += 1;
    };
    // A clock started in the other mode (Shadow ↔ Live) is not this mode's to finish.
    if (clock.shadow !== ctx.shadow) return stop('mode_off');
    const left = this._leftScope(ctx, clock, ticket);
    if (left) return stop(left);
    if ((await this._touchedSince(ctx, ticket, clock.startedAt)).touched) return stop('touched');

    if (clock.state === 'waiting') return this._evaluateWaiting(ctx, clock, ticket, out);
    if (clock.moveAt && now.getTime() >= new Date(clock.moveAt).getTime()) return this._clockMove(ctx, clock, ticket, out);
    if (clock.notifyAt && !clock.notifiedAt && now.getTime() >= new Date(clock.notifyAt).getTime()) return this._clockNotify(ctx, clock, ticket, out);
    return null;
  }

  /** The notify deadline: the people at work are told, once. */
  async _clockNotify(ctx, clock, ticket, out) {
    const { settings, now } = ctx;
    if (!(await this._claim(clock, { notifiedAt: now }, { notifiedAt: null }))) return;
    const owner = await this._person(ctx, ticket.assignedTechId);
    const from = who(ticket.assignedTechId, nameOf(owner, ticket.assignedTechId));
    const sentence = sentenceFor('team_told', { shadow: ctx.shadow, priority: ticket.priority, minutes: settings.clockNotifyMinutes });
    const row = await this._record(ctx, {
      ticket, layer: 'clock', action: 'team_told', from, sentence, dedupeKey: `clock:${ticket.id}:${new Date(clock.startedAt).toISOString()}:team_told`,
    });
    if (!row || row === 'duplicate') return;
    out.told += 1;
    await this._tell(ctx, {
      technicianIds: await this._audience(ctx, ticket),
      title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)} has not been touched for ${settings.clockNotifyMinutes} minutes`,
      lines: [
        this._subjectLine(ticket),
        sentence,
        `It is with ${from.name}.`,
        settings.maxMoves > clock.moveCount
          ? `If nobody touches it, it moves to someone at work after ${settings.clockMoveMinutes} minutes.`
          : `If nobody touches it, it goes to the coordinator after ${settings.clockMoveMinutes} minutes.`,
      ],
      ticket,
      refKey: `urgent-team-told:${ticket.id}:${row.id}`,
    });
  }

  /** The move deadline: the next person at work, or the coordinator when the chain is used up. */
  async _clockMove(ctx, clock, ticket, out) {
    const { settings, now } = ctx;
    const owner = await this._person(ctx, ticket.assignedTechId);
    const ownerState = this._state(ctx, owner, now);
    const chain = clock.chainTechnicianIds || [];
    if (clock.moveCount >= settings.maxMoves) return this._toCoordinator(ctx, clock, ticket, owner, out);

    const pick = await this.pickResponder(ctx.workspaceId, ticket, { exclude: [...chain, ticket.assignedTechId], now, ctx });
    if (!pick.chosen) {
      return this._nobodyAtWork(ctx, ticket, {
        layer: 'clock', owner, startedAt: clock.startedAt, notifyAt: clock.notifyAt, moveAt: clock.moveAt, notifiedAt: clock.notifiedAt, moveCount: clock.moveCount, chain, out,
      });
    }
    if (!(await this._claim(clock, { state: 'stopped', stoppedAt: now, stopReason: 'moved' }, { moveCount: clock.moveCount }))) return null;
    return this._move(ctx, ticket, {
      layer: 'clock', owner, ownerState, pick, moveCount: clock.moveCount, chain, startedAt: clock.startedAt, minutes: settings.clockMoveMinutes, out,
    });
  }

  /**
   * A waiting clock: nobody was at work. A clock that waits since its move
   * deadline (moveAt kept) moves as soon as anybody else is at work; one that
   * waits since the ticket became urgent goes back to a running clock when
   * its owner comes on shift first.
   */
  async _evaluateWaiting(ctx, clock, ticket, out) {
    const { settings, now } = ctx;
    const owner = await this._person(ctx, ticket.assignedTechId);
    const ownerState = this._state(ctx, owner, now, settings.assignGraceMinutes);
    const chain = clock.chainTechnicianIds || [];
    const layer = clock.moveAt ? 'clock' : 'raise';

    const restart = async () => {
      const data = await this._clockFor(ctx, ticket, { ownerId: ticket.assignedTechId, moveCount: clock.moveCount, chain });
      if (await this._claim(clock, data) && data.state === 'running') out.started += 1;
    };
    if (layer === 'raise' && ownerState.atWork) return restart();

    const pick = await this.pickResponder(ctx.workspaceId, ticket, { exclude: [...chain, ticket.assignedTechId], now, ctx });
    if (!pick.chosen) return layer === 'clock' && ownerState.atWork ? restart() : null;
    if (!(await this._claim(clock, { state: 'stopped', stoppedAt: now, stopReason: 'moved' }))) return null;
    return this._move(ctx, ticket, {
      layer,
      owner,
      ownerState,
      pick,
      moveCount: clock.moveCount,
      chain,
      startedAt: clock.startedAt,
      minutes: layer === 'clock' ? settings.clockMoveMinutes : null,
      becameAt: layer === 'raise' ? minutesToTime(localParts(new Date(clock.startedAt), ctx.timezone).minutes) : null,
      out,
    });
  }

  /** The chain is used up: the coordinator gets it (when one is set and active), is told, and the clock ends. */
  async _toCoordinator(ctx, clock, ticket, owner, out) {
    const { settings, now } = ctx;
    if (!(await this._claim(clock, { state: 'stopped', stoppedAt: now, stopReason: 'coordinator' }))) return;
    out.stopped += 1;
    const from = who(ticket.assignedTechId, nameOf(owner, ticket.assignedTechId));
    const coordinator = settings.coordinatorTechnicianId ? await this._person(ctx, settings.coordinatorTechnicianId) : null;
    const usable = coordinator?.isActive ? coordinator : null;
    const alreadyOwner = Boolean(usable && usable.id === ticket.assignedTechId);
    const key = `clock:${ticket.id}:${new Date(clock.startedAt).toISOString()}:coordinator`;
    const base = { shadow: ctx.shadow, priority: ticket.priority, from: from.name, moves: clock.moveCount };

    let to = usable && !alreadyOwner ? who(usable.id, usable.name) : null;
    if (to && !ctx.shadow) {
      try {
        await this.moveTicket(ticket, usable);
        // The stopped row follows the ticket, or the next sweep would read a new owner as a new cycle.
        await prisma.urgentResponseClock.updateMany({ where: { ticketId: ticket.id, state: 'stopped' }, data: { ownerTechnicianId: usable.id } });
      } catch (err) {
        await this._failed(ctx, ticket, {
          layer: 'clock', from, to, attempts: [{ technicianId: usable.id, name: usable.name, error: String(err.message || err).slice(0, 300) }], startedAt: clock.startedAt, out, keepClock: true,
        });
        to = null;
      }
    }
    const sentence = sentenceFor('coordinator', { ...base, to: to?.name || null, alreadyOwner });
    const row = await this._record(ctx, {
      ticket, layer: 'clock', action: 'coordinator', from, to, sentence, details: { moves: clock.moveCount, coordinatorTechnicianId: usable?.id ?? null }, dedupeKey: key,
    });
    if (row && row !== 'duplicate' && usable) {
      await this._tell(ctx, {
        technicianIds: uniq([usable.id, from.id]),
        title: `${priorityWord(ticket.priority)} ticket ${ticketDisplayRef(ticket)} is still untouched`,
        lines: [this._subjectLine(ticket), sentence],
        ticket,
        refKey: `urgent-coordinator:${ticket.id}:${row.id}`,
      });
    }
  }

  // ---- layer 1: when assigning -----------------------------------------------

  /**
   * Called by the AI pipeline just before it writes an auto-assignment: the
   * ticket never goes to someone who is not at work (or starting within the
   * grace minutes) — the best person at work gets it instead.
   *
   * @param {{ workspaceId: number, ticket: object, techId: number, assessedPriorityId?: number|null, runId?: number|null,
   *   now?: Date, dryRun?: boolean }} input
   *   `ticket`: at least `{ id }`; category ids on it win over the saved row (the run has not persisted them yet).
   *   `dryRun`: the pipeline applies nothing, so the guard is Shadow whatever the mode.
   * @returns {{ outcome: 'keep'|'redirect'|'hold'|'on_call', techId: number|null, techName?: string|null, sentence: string|null, shadow: boolean }}
   *   Shadow results describe what would have happened; the caller changes nothing. Any error → keep.
   */
  async guardAutoAssignment({ workspaceId, ticket, techId, assessedPriorityId = null, runId = null, now = new Date(), dryRun = false } = {}) {
    const keep = { outcome: 'keep', techId: techId ?? null, sentence: null, shadow: false };
    try {
      const ws = Number(workspaceId);
      const originalId = Number(techId);
      if (!isPositiveId(originalId) || !ticket?.id || SANDBOX_WORKSPACES.includes(ws)) return keep;
      const mode = await settingsService.getMode(ws);
      if (mode === 'off') return keep;
      const settings = await settingsService.getSettings(ws, { suggest: false });
      const saved = await soft(() => prisma.ticket.findUnique({ where: { id: Number(ticket.id) }, select: TICKET_SELECT }), null);
      const row = { ...(saved || {}), ...Object.fromEntries(Object.entries(ticket).filter(([, v]) => v !== undefined && v !== null)), workspaceId: ws };
      // Layer 1 runs before the native priority is written: the run's assessed priority, then the saved one.
      const priority = [Number(assessedPriorityId), Number(row.assessedPriorityId), Number(row.priority)].find((p) => [1, 2, 3, 4].includes(p)) ?? null;
      if (!settings.assignEnabled || !settings.assignPriorities.includes(priority)) return keep;

      const ctx = await this._context(ws, now, { mode: dryRun ? 'observe' : mode, settings });
      const original = await this._person(ctx, originalId);
      const state = this._state(ctx, original, now, settings.assignGraceMinutes);
      if (state.atWork) return keep;

      const shadow = ctx.shadow;
      const from = who(originalId, nameOf(original, originalId));
      const reason = awayPhrase(from.name, state);
      const guarded = { ...row, priority };
      const key = runId ? `assign:${runId}` : null;
      const pick = await this.pickResponder(ws, guarded, { exclude: [originalId], now, graceMinutes: settings.assignGraceMinutes, ctx });

      if (pick.chosen) {
        const to = who(pick.chosen.id, pick.chosen.name);
        const sentence = sentenceFor('redirected', { shadow, priority, from: from.name, to: to.name, reason });
        await this._record(ctx, {
          ticket: guarded, layer: 'assign', action: 'redirected', from, to, sentence, priority, dedupeKey: key,
          details: { runId, why: pick.chosen.why, considered: pick.considered.slice(0, 10).map((p) => ({ id: p.id, name: p.name, why: p.why })) },
        });
        return { outcome: 'redirect', techId: to.id, techName: to.name, sentence, shadow };
      }

      // Nobody is at work.
      let onCall = null;
      if (settings.nobodyMode === 'on_call') {
        const current = await soft(() => onCallService.current(ws, now), null);
        const fits = current?.technician && !current.onLeaveNoCover ? await this._person(ctx, current.technician.id) : null;
        // A FreshService ticket can only go to somebody with a FreshService seat.
        if (fits?.isActive && (guarded.origin === 'ticketpulse' || (fits.freshserviceId && fits.origin !== 'local'))) onCall = fits;
      }
      if (onCall) {
        const to = who(onCall.id, onCall.name);
        let sms = null;
        if (!shadow) {
          const notifier = await soft(() => this._notifier(), null);
          sms = notifier
            ? await notifier.textOnCall(onCall, `Ticket Pulse: ${priorityWord(priority)} ticket ${this._subjectLine(guarded)} is yours as the on-call person. Nobody is at work.`)
            : { sent: false, reason: 'send_failed' };
        }
        const sentence = sentenceFor('on_call_assigned', { shadow, priority, to: to.name, texted: sms?.sent === true });
        const logged = await this._record(ctx, {
          ticket: guarded, layer: 'assign', action: 'on_call_assigned', from: onCall.id === originalId ? null : from, to, sentence, priority, dedupeKey: key,
          details: { runId, sms: sms ? { sent: sms.sent === true, reason: sms.reason || null } : null },
        });
        await this._tell(ctx, {
          technicianIds: [onCall.id],
          title: `${priorityWord(priority)} ticket ${ticketDisplayRef(guarded)} is with the on-call person, ${to.name}`,
          lines: [this._subjectLine(guarded), sentence],
          ticket: guarded,
          refKey: `urgent-on-call:${guarded.id}:${logged?.id || runId || now.getTime()}`,
        });
        return { outcome: 'on_call', techId: to.id, techName: to.name, sentence, shadow };
      }

      const contact = await this._nobodyContact(ctx);
      const sentence = sentenceFor('held', { shadow, layer: 'assign', priority, from: from.name });
      const logged = await this._record(ctx, {
        ticket: guarded, layer: 'assign', action: 'held', from, sentence, priority, dedupeKey: key, details: { runId, reason, contactTechnicianId: contact?.id ?? null },
      });
      if (contact) {
        await this._tell(ctx, {
          technicianIds: [contact.id],
          title: `${priorityWord(priority)} ticket ${ticketDisplayRef(guarded)}: nobody is at work`,
          lines: [this._subjectLine(guarded), sentence, 'It waits in Assignment Review.'],
          ticket: guarded,
          refKey: `urgent-held:${guarded.id}:${logged?.id || runId || now.getTime()}`,
        });
      }
      return { outcome: 'hold', techId: null, sentence, shadow };
    } catch (err) {
      logger.warn('Urgent response: the assignment guard failed, the assignment goes ahead', { ticketId: ticket?.id ?? null, workspaceId, error: err.message });
      return keep;
    }
  }

  // ---- reads -----------------------------------------------------------------

  _item(row, ticket) {
    return {
      id: row.id,
      createdAt: row.createdAt,
      layer: row.layer,
      action: row.action,
      shadow: row.shadow === true,
      priority: row.priority ?? null,
      ticket: ticket ? { id: ticket.id, displayRef: ticketDisplayRef(ticket), subject: ticket.subject || null } : null,
      from: who(row.fromTechnicianId, row.fromName),
      to: who(row.toTechnicianId, row.toName),
      sentence: row.sentence || null,
      details: row.details ?? null,
      undoable: this.isUndoable(row, ticket),
      undoneAt: row.undoneAt || null,
      undoneBy: row.undoneBy || null,
    };
  }

  /**
   * The log, newest first, paged by id.
   * @param {{ limit?: number, before?: number, layer?: string, shadow?: boolean|string }} opts
   *   `shadow`: true / 'true' = Shadow rows only, false / 'false' = live rows only, anything else = both.
   * @returns {{ items: object[], nextBefore: number|null }} `nextBefore` = pass it as `before` for the next page.
   */
  async listActions(workspaceId, { limit = 50, before = null, layer = null, shadow = null } = {}) {
    const ws = Number(workspaceId);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const beforeId = Number(before);
    const onlyShadow = shadow === true || shadow === 'true' ? true : (shadow === false || shadow === 'false' ? false : null);
    const rows = await soft(() => prisma.urgentResponseAction.findMany({
      where: {
        workspaceId: ws,
        ...(Number.isInteger(beforeId) && beforeId > 0 ? { id: { lt: beforeId } } : {}),
        ...(LAYERS.includes(layer) ? { layer } : {}),
        ...(onlyShadow === null ? {} : { shadow: onlyShadow }),
      },
      orderBy: { id: 'desc' },
      take: take + 1,
    }), []);
    const page = rows.slice(0, take);

    // One batched read for the ticket of every row on the page.
    const ticketIds = [...new Set(page.map((r) => r.ticketId).filter(Boolean))];
    const tickets = ticketIds.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: ticketIds }, workspaceId: ws },
      select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, assignedTechId: true },
      take: ticketIds.length,
    }), []) : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));

    return {
      items: page.map((row) => this._item(row, row.ticketId ? byId.get(row.ticketId) : null)),
      nextBefore: rows.length > take ? page[page.length - 1].id : null,
    };
  }

  /** One log row of this workspace (the routes check ownership with it before acting on an id). */
  async getAction(workspaceId, actionId) {
    const row = await soft(() => prisma.urgentResponseAction.findFirst({ where: { id: Number(actionId) || 0, workspaceId: Number(workspaceId) } }));
    if (!row) throw new NotFoundError('That log entry was not found');
    return row;
  }

  /** A live move with a "from" person, not undone yet, whose ticket is still with the "to" person. */
  isUndoable(row, ticket) {
    return Boolean(
      row && ticket
      && row.shadow !== true
      && UNDOABLE_ACTIONS.includes(row.action)
      && !row.undoneAt
      && row.fromTechnicianId && row.toTechnicianId
      && ticket.assignedTechId === row.toTechnicianId,
    );
  }

  /** Counts by action between two instants, live and Shadow apart; `moved` also split by layer. */
  async _counts(workspaceId, { since, until = null }) {
    const groups = await soft(() => prisma.urgentResponseAction.groupBy({
      by: ['action', 'shadow', 'layer'],
      where: {
        workspaceId: Number(workspaceId),
        createdAt: { gte: since, ...(until ? { lt: until } : {}) },
        action: { in: Object.keys(STAT_KEYS) },
      },
      _count: { _all: true },
    }), []);
    const out = { live: emptyCounts(), shadow: emptyCounts() };
    for (const g of groups) {
      const key = STAT_KEYS[g.action];
      if (!key) continue;
      const side = out[g.shadow ? 'shadow' : 'live'];
      const n = g._count?._all || 0;
      side[key] += n;
      if (g.action === 'moved' && g.layer === 'raise') side.raiseMoved += n;
      if (g.action === 'moved' && g.layer === 'clock') side.clockMoved += n;
    }
    return out;
  }

  /**
   * Counts of the last `days` days, live and Shadow apart. No per-person numbers.
   * @returns {{ days: number, live: object, shadow: object }} keys: redirected, held, moved, toldOwnerAway, teamTold,
   *   coordinator, onCallAssigned, undone, raiseMoved, clockMoved (moved = raiseMoved + clockMoved).
   */
  async stats(workspaceId, { days = 30, now = new Date() } = {}) {
    const span = Math.min(Math.max(Number(days) || 30, 1), 365);
    const counts = await this._counts(workspaceId, { since: new Date(now.getTime() - span * DAY_MS) });
    return { days: span, ...counts };
  }

  /**
   * The clock line of the ticket page: only in Live mode, only while the clock
   * runs or waits.
   * @returns {{ state, startedAt, notifyAt, moveAt, notifiedAt, notifyMinutes, moveMinutes } | null}
   */
  async clockView(ticketId) {
    const row = await soft(() => prisma.urgentResponseClock.findUnique({ where: { ticketId: Number(ticketId) || 0 } }), null);
    if (!row || !ACTIVE_STATES.includes(row.state) || row.shadow) return null;
    const settings = await soft(() => settingsService.getSettings(row.workspaceId, { suggest: false }), null);
    if (settings?.mode !== 'live') return null;
    return {
      state: row.state,
      startedAt: row.startedAt,
      notifyAt: row.notifyAt || null,
      moveAt: row.moveAt || null,
      notifiedAt: row.notifiedAt || null,
      notifyMinutes: settings.clockNotifyMinutes,
      moveMinutes: settings.clockMoveMinutes,
    };
  }

  /**
   * What the rule did between two instants, for the weekly admin e-mail.
   * @returns {{ mode: string, live: object, shadow: object, examples: Array<{ createdAt, sentence, ticketId, displayRef }> }}
   *   `live` / `shadow`: the keys of stats(). `examples`: at most five, live rows first, newest first.
   */
  async weeklySummary(workspaceId, { since, until = new Date() } = {}) {
    const ws = Number(workspaceId);
    const to = until instanceof Date ? until : new Date(until);
    const from = since ? new Date(since) : new Date(to.getTime() - 7 * DAY_MS);
    const mode = await settingsService.getMode(ws);
    const counts = await this._counts(ws, { since: from, until: to });
    const rows = await soft(() => prisma.urgentResponseAction.findMany({
      where: { workspaceId: ws, createdAt: { gte: from, lt: to }, ticketId: { not: null }, action: { in: Object.keys(STAT_KEYS).filter((a) => a !== 'undone') } },
      select: { id: true, createdAt: true, sentence: true, ticketId: true, shadow: true },
      orderBy: [{ shadow: 'asc' }, { createdAt: 'desc' }],
      take: 5,
    }), []);
    const ids = uniq(rows.map((r) => r.ticketId));
    const tickets = ids.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: ids }, workspaceId: ws },
      select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
      take: ids.length,
    }), []) : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    return {
      mode,
      ...counts,
      examples: rows.map((r) => ({
        createdAt: r.createdAt, sentence: r.sentence || null, ticketId: r.ticketId, displayRef: byId.has(r.ticketId) ? ticketDisplayRef(byId.get(r.ticketId)) : null,
      })),
    };
  }

  // ---- undo ------------------------------------------------------------------

  /**
   * Move a ticket back: a live moved / redirected / on_call_assigned /
   * coordinator row with a "from" person, while the ticket is still with the
   * "to" person. Anything else is a 409 with a plain reason. Afterwards the
   * clock is stopped ('undone') so the rule does not move it again.
   * @param {number} actionId the log row (the route has checked its workspace)
   * @param {{ email?: string, name?: string }} actor the session user
   * @returns {object} the original row as a log item (listActions shape)
   */
  async undo(actionId, actor = null, { now = new Date() } = {}) {
    const row = await prisma.urgentResponseAction.findUnique({ where: { id: Number(actionId) || 0 } });
    if (!row) throw new NotFoundError('That log entry was not found');
    if (row.shadow) throw new ConflictError('This is a Shadow entry: nothing was moved, so there is nothing to undo');
    if (!UNDOABLE_ACTIONS.includes(row.action) || !row.fromTechnicianId || !row.toTechnicianId || !row.ticketId) throw new ConflictError('This entry did not move a ticket, so there is nothing to undo');
    if (row.undoneAt) throw new ConflictError('This has already been undone');
    const ticket = await prisma.ticket.findFirst({ where: { id: row.ticketId, workspaceId: row.workspaceId }, select: TICKET_SELECT });
    if (!ticket) throw new ConflictError('The ticket no longer exists');
    if (ticket.assignedTechId !== row.toTechnicianId) {
      throw new ConflictError(`The ticket has moved on since: it is no longer with ${row.toName || 'that person'}`);
    }

    const by = actor?.email || actor?.name || 'unknown';
    const claimed = await prisma.urgentResponseAction.updateMany({ where: { id: row.id, undoneAt: null }, data: { undoneAt: now, undoneBy: by } });
    if (!claimed.count) throw new ConflictError('This has already been undone');
    try {
      await this.moveTicket(ticket, { id: row.fromTechnicianId }, { allowAssignableOnly: true });
    } catch (err) {
      await prisma.urgentResponseAction.updateMany({ where: { id: row.id }, data: { undoneAt: null, undoneBy: null } }).catch(() => {});
      logger.warn('Urgent response: undo failed', { ticketId: ticket.id, workspaceId: row.workspaceId, actionId: row.id, error: err.message });
      throw new ConflictError(`It could not be moved back to ${row.fromName || 'that person'}: ${err.message}`);
    }

    const ctx = { workspaceId: row.workspaceId, now, shadow: false };
    const back = who(row.fromTechnicianId, row.fromName);
    await this._record(ctx, {
      ticket,
      layer: 'undo',
      action: 'undone',
      from: who(row.toTechnicianId, row.toName),
      to: back,
      sentence: sentenceFor('undone', { to: back.name, actor: actor?.name || actor?.email }),
      details: { by },
      undoOfId: row.id,
    });
    // The owner on the row is the person it went back to, so the next sweep sees nothing new.
    await soft(() => this._setClock(ctx, ticket.id, this._stoppedData(ctx, { ownerId: row.fromTechnicianId, reason: 'undone' })));
    return this._item({ ...row, undoneAt: now, undoneBy: by }, { ...ticket, assignedTechId: row.fromTechnicianId });
  }

  // ---- preview ---------------------------------------------------------------

  /**
   * What a draft of the settings would have done over the last `days` days —
   * an ESTIMATE replayed from history with today's team, shifts and owners:
   *   assign: auto-assigned runs whose person was not at work when decided;
   *   raise:  priority raises into scope whose owner was not at work;
   *   clock:  tickets in scope with no agent entry within the notify / move minutes.
   * Bounded reads, one after the other. Only a bad draft throws (ValidationError).
   * @returns {{ days, estimate: true, assign: { redirected, held }, raise: { moved, told },
   *   clock: { teamTold, moved, coordinator }, inScopeTickets }}
   */
  async preview(workspaceId, draft = {}, { days = 30, now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const span = Math.min(Math.max(Number(days) || 30, 1), 90);
    const saved = await settingsService.getSettings(ws, { suggest: false });
    const settings = normalizeSettings({ ...saved, ...(draft && typeof draft === 'object' ? draft : {}) });
    const errors = validateSettings(settings);
    if (errors.length) throw new ValidationError(errors[0], errors);

    const out = {
      days: span, estimate: true, assign: { redirected: 0, held: 0 }, raise: { moved: 0, told: 0 }, clock: { teamTold: 0, moved: 0, coordinator: 0 }, inScopeTickets: 0,
    };
    const since = new Date(now.getTime() - span * DAY_MS);
    const section = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        logger.warn(`Urgent response: preview of "${name}" skipped for workspace ${ws}: ${err.message}`);
      }
    };
    let ctx = null;
    await section('context', async () => {
      ctx = await this._context(ws, now, { mode: 'observe', settings, leaveFrom: since });
      ctx.openStatuses = await this._openStatuses(ws);
    });
    if (!ctx) return out;

    // Was anybody at work at an instant? Answered once per quarter of an hour.
    const somebody = new Map();
    const anyoneElseAtWork = (at, exceptId, grace = 0) => {
      const key = `${Math.floor(at.getTime() / (15 * MINUTE_MS))}:${exceptId}:${grace}`;
      if (!somebody.has(key)) somebody.set(key, ctx.technicians.some((t) => t.id !== exceptId && this._state(ctx, t, at, grace).atWork));
      return somebody.get(key);
    };
    const ticketsById = async (ids, select) => {
      const map = new Map();
      for (let i = 0; i < ids.length; i += PREVIEW_CHUNK) {
        const chunk = ids.slice(i, i + PREVIEW_CHUNK);
        const rows = await prisma.ticket.findMany({ where: { id: { in: chunk }, workspaceId: ws }, select, take: chunk.length });
        for (const r of rows) map.set(r.id, r);
      }
      return map;
    };

    await section('in scope', async () => {
      if (!ctx.scope.length) return;
      out.inScopeTickets = await prisma.ticket.count({ where: this._inScopeWhere(ctx) });
    });

    if (settings.assignEnabled) {
      await section('assign', async () => {
        const runs = await prisma.assignmentPipelineRun.findMany({
          where: { workspaceId: ws, decision: 'auto_assigned', decidedAt: { gte: since }, assignedTechId: { not: null } },
          select: { id: true, ticketId: true, assignedTechId: true, decidedAt: true },
          orderBy: { id: 'desc' },
          take: PREVIEW_ROWS,
        });
        const tickets = await ticketsById(uniq(runs.map((r) => r.ticketId)), { id: true, priority: true, assessedPriorityId: true });
        for (const run of runs) {
          const t = tickets.get(run.ticketId);
          const priority = [1, 2, 3, 4].includes(Number(t?.assessedPriorityId)) ? Number(t.assessedPriorityId) : Number(t?.priority);
          if (!settings.assignPriorities.includes(priority) || !run.decidedAt) continue;
          const tech = await this._person(ctx, run.assignedTechId);
          // Somebody who has left since says nothing about the rule.
          if (!tech || (!tech.isActive && !tech.assignableOnly)) continue;
          if (this._state(ctx, tech, run.decidedAt, settings.assignGraceMinutes).atWork) continue;
          if (anyoneElseAtWork(run.decidedAt, run.assignedTechId, settings.assignGraceMinutes)) out.assign.redirected += 1;
          else out.assign.held += 1;
        }
      });
    }

    if (settings.raiseEnabled) {
      await section('raise', async () => {
        const events = await prisma.ticketPriorityEvent.findMany({
          where: { workspaceId: ws, detectedAt: { gte: since }, toPriorityId: { in: settings.raisePriorities } },
          select: { ticketId: true, fromPriorityId: true, toPriorityId: true, detectedAt: true },
          orderBy: { detectedAt: 'desc' },
          take: PREVIEW_ROWS,
        });
        const raises = events.filter((e) => !settings.raisePriorities.includes(e.fromPriorityId));
        const tickets = await ticketsById(uniq(raises.map((e) => e.ticketId)), { id: true, assignedTechId: true, isSelfPicked: true });
        for (const event of raises) {
          const t = tickets.get(event.ticketId);
          if (!t?.assignedTechId) continue;
          const owner = await this._person(ctx, t.assignedTechId);
          if (!owner || (!owner.isActive && !owner.assignableOnly)) continue;
          if (this._state(ctx, owner, event.detectedAt, settings.assignGraceMinutes).atWork) continue;
          const tellOnly = (settings.raiseManualAction === 'notify' && t.isSelfPicked) || !anyoneElseAtWork(event.detectedAt, t.assignedTechId);
          if (tellOnly) out.raise.told += 1;
          else out.raise.moved += 1;
        }
      });
    }

    if (settings.clockEnabled) {
      await section('clock', async () => {
        const tickets = await prisma.ticket.findMany({
          where: { workspaceId: ws, priority: { in: settings.clockPriorities }, assignedAt: { gte: since }, assignedTechId: { not: null } },
          select: { id: true, createdAt: true, assignedAt: true, resolvedAt: true, closedAt: true },
          orderBy: { id: 'desc' },
          take: PREVIEW_ROWS,
        });
        const firstTouch = new Map();
        const ids = tickets.map((t) => t.id);
        const startOf = new Map(tickets.map((t) => [t.id, new Date(t.assignedAt || t.createdAt)]));
        for (let i = 0; i < ids.length; i += PREVIEW_THREAD_CHUNK) {
          const chunk = ids.slice(i, i + PREVIEW_THREAD_CHUNK);
          const entries = await prisma.ticketThreadEntry.findMany({
            where: {
              ticketId: { in: chunk },
              occurredAt: { gte: since },
              OR: [{ authorType: 'agent' }, { authorType: null, eventType: { in: FS_AGENT_EVENT_TYPES } }],
            },
            select: { ticketId: true, occurredAt: true },
            orderBy: { occurredAt: 'asc' },
            take: PREVIEW_ROWS,
          });
          for (const e of entries) {
            if (firstTouch.has(e.ticketId) || e.occurredAt.getTime() <= startOf.get(e.ticketId).getTime()) continue;
            firstTouch.set(e.ticketId, e.occurredAt);
          }
        }
        const opts = { workspaceId: ws, calendar: ctx.calendar };
        for (const t of tickets) {
          const start = startOf.get(t.id);
          const ended = [firstTouch.get(t.id), t.resolvedAt, t.closedAt, now].filter(Boolean).map((d) => new Date(d).getTime());
          const until = Math.min(...ended);
          const notifyAt = await businessCalendarService.addBusinessMinutes(start, settings.clockNotifyMinutes, opts);
          if (until < notifyAt.getTime()) continue;
          out.clock.teamTold += 1;
          for (let move = 1; move <= settings.maxMoves + 1; move++) {
            const moveAt = await businessCalendarService.addBusinessMinutes(start, settings.clockMoveMinutes * move, opts);
            if (until < moveAt.getTime()) break;
            if (move > settings.maxMoves) out.clock.coordinator += 1;
            else out.clock.moved += 1;
          }
        }
      });
    }
    return out;
  }
}

const urgentResponseService = new UrgentResponseService();
export default urgentResponseService;
export { UrgentResponseService, ACTOR as URGENT_RESPONSE_ACTOR };
