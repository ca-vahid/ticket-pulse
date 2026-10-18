/**
 * Owner away when the requester replies (13 Oct 2026).
 *
 * Karen Wong replied to resolved #245828; Ticket Pulse reopened it under its
 * old owner. Had he been on vacation, the reply would have waited for him and
 * nobody else would have known. When a requester reply reopens a ticket, or
 * lands on an open one, and the owner is away for more than a day, this clears
 * the owner and sends the ticket back through assignment, with a private note
 * and a history entry saying why.
 *
 * Rules (each one has a test in tests/ownerAwayReroute.test.js):
 *  - "Away" = an approved FULL-DAY leave of category OFF in `technician_leaves`,
 *    the same rows assignment reads to skip absent people (Vacation Tracker and
 *    Availability both write there). Working from home, site visits and half
 *    days are not absences.
 *  - Away NOW = away on the first working day from today (today on a working
 *    day; Monday for a reply that arrives on Saturday).
 *  - A short absence is left alone: the ticket moves only when the owner is
 *    away for MIN_WORKING_DAYS_AWAY working days or more counting that day,
 *    i.e. they are NOT back on the next working day. One day off does not
 *    shuffle tickets.
 *  - Never for a ticket the onboarding engine parked, a child or parent of an
 *    onboarding / offboarding family, or trusted intake (machine alerts).
 *  - Once per ticket per absence: if someone gives the ticket back to the same
 *    person during the same absence, it stays with them.
 *  - Per-workspace switch (requesterReplyRulesService): ON for IT, OFF elsewhere.
 *
 * Both origins use the write path a coordinator uses: assignTicket(…, null)
 * for a Ticket Pulse ticket, updateFsTicket({ assignedTechId: null }) for a
 * FreshService one (FreshService accepts an empty agent). The new assignment
 * run goes through reboundRunService, the route every returned ticket takes:
 * it carries who had the ticket and why it came back, and it does not re-run
 * the new-ticket guards (grouping, duplicate burst) on an old ticket.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';
import { getRequesterReplyRules } from './requesterReplyRulesService.js';

/** The ticket moves when the owner is away this many working days or more, counting the first. */
export const MIN_WORKING_DAYS_AWAY = 2;
/** How far ahead the leave calendar is read. */
const LOOKAHEAD_DAYS = 120;
export const OWNER_AWAY_ACTIVITY = 'owner_away_reroute';
export const OWNER_AWAY_ACTOR = Object.freeze({ name: 'Ticket Pulse (owner away)', email: null, role: 'automation', technicianId: null });
const FALLBACK_TIMEZONE = 'America/Vancouver';

const soft = (fn, fallback) => Promise.resolve().then(fn).catch(() => fallback);

const addDay = (dateStr, n = 1) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayOfWeekOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sunday

export function localDateStr(at, timeZone = FALLBACK_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** "Mon 19 Oct" from 'yyyy-MM-dd' (a calendar day, no zone shift). */
export function friendlyDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

/**
 * The owner's current absence, from their full-day OFF dates.
 *
 * @param {object} p
 * @param {Set<string>} p.offDates  'yyyy-MM-dd' days with an approved full-day OFF leave
 * @param {string} p.today          'yyyy-MM-dd' in the workspace's zone
 * @param {(dateStr: string) => boolean} p.isWorkingDay
 * @returns {null | { firstDay, lastDay, backOn, workingDaysAway }} null when the
 *   owner is not away on the first working day from today. `backOn` is the
 *   first working day they are not on leave (null when the leave runs past the
 *   look-ahead).
 */
export function currentAbsence({ offDates, today, isWorkingDay }) {
  let day = today;
  let guard = 0;
  while (!isWorkingDay(day) && guard < 14) { day = addDay(day); guard += 1; }
  if (!isWorkingDay(day) || !offDates.has(day)) return null;
  const firstDay = day;
  let lastDay = day;
  let workingDaysAway = 0;
  let backOn = null;
  for (let i = 0; i < LOOKAHEAD_DAYS; i += 1) {
    if (isWorkingDay(day)) {
      if (!offDates.has(day)) { backOn = day; break; }
      workingDaysAway += 1;
      lastDay = day;
    }
    day = addDay(day);
  }
  return { firstDay, lastDay, backOn, workingDaysAway };
}

class OwnerAwayRerouteService {
  constructor() {
    this._inFlight = new Set();
  }

  /** Working-day test for the workspace: its business days minus holidays; Mon–Fri when none are set. */
  async _calendar(workspaceId) {
    const cal = await soft(async () => {
      const { default: businessCalendarService } = await import('./businessCalendarService.js');
      return businessCalendarService.loadCalendar(workspaceId);
    }, null);
    if (cal?.byDay?.size) {
      return {
        timezone: cal.timezone || FALLBACK_TIMEZONE,
        isWorkingDay: (dateStr) => cal.byDay.has(dayOfWeekOf(dateStr)) && !cal.isHolidayDate(dateStr),
      };
    }
    const ws = await soft(() => prisma.workspace.findUnique({ where: { id: workspaceId }, select: { defaultTimezone: true } }), null);
    return {
      timezone: ws?.defaultTimezone || FALLBACK_TIMEZONE,
      isWorkingDay: (dateStr) => { const dow = dayOfWeekOf(dateStr); return dow >= 1 && dow <= 5; },
    };
  }

  /** The owner's absence right now, or null. Reads the same rows assignment uses. */
  async absenceFor(technicianId, workspaceId, { now = new Date() } = {}) {
    const { timezone, isWorkingDay } = await this._calendar(workspaceId);
    const today = localDateStr(now, timezone);
    const rows = await soft(() => prisma.technicianLeave.findMany({
      where: {
        technicianId: Number(technicianId),
        status: 'APPROVED',
        category: 'OFF',
        leaveDate: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${addDay(today, LOOKAHEAD_DAYS + 14)}T00:00:00Z`) },
      },
      select: { leaveDate: true, isFullDay: true },
      take: 400,
    }), []);
    const offDates = new Set((rows || [])
      .filter((r) => r.isFullDay !== false && r.leaveDate)
      .map((r) => new Date(r.leaveDate).toISOString().slice(0, 10)));
    if (!offDates.size) return null;
    const absence = currentAbsence({ offDates, today, isWorkingDay });
    return absence ? { ...absence, today, timezone } : null;
  }

  /** Why this ticket is left alone whatever the owner's calendar says, or null. */
  async exemptionFor(ticket) {
    if (ticket.triageMode === 'trusted') return 'trusted_intake';
    const [park, member, parent] = await Promise.all([
      soft(() => prisma.ticketPark.findFirst({ where: { ticketId: ticket.id, endedAt: null, source: 'suggested_hr' }, select: { id: true } }), null),
      soft(() => prisma.hrLifecycleFamilyMember.findFirst({ where: { ticketId: ticket.id }, select: { id: true } }), null),
      soft(() => prisma.hrLifecycleFamily.findFirst({ where: { parentTicketId: ticket.id }, select: { id: true } }), null),
    ]);
    if (park) return 'parked_by_onboarding';
    if (member || parent) return 'onboarding_family';
    return null;
  }

  /** Was this ticket already sent back for this same absence of this same person? */
  async _alreadyRerouted(ticketId, technicianId, absence) {
    const rows = await soft(() => prisma.ticketActivity.findMany({
      where: { ticketId, activityType: OWNER_AWAY_ACTIVITY },
      orderBy: { id: 'desc' },
      take: 10,
      select: { details: true },
    }), []);
    return (rows || []).some((r) => {
      const d = r.details && typeof r.details === 'object' ? r.details : {};
      if (Number(d.technicianId) !== Number(technicianId)) return false;
      // Same absence = the recorded one had not ended when this one began.
      return !d.lastDay || String(d.lastDay) >= absence.firstDay;
    });
  }

  /**
   * Run after a requester reply was recorded (and after the reopen workflow
   * had its turn). Never throws; returns what it did and why.
   *
   * @param {number} ticketId
   * @param {number} workspaceId
   * @param {object} [opts]
   * @param {Date}   [opts.now]
   * @param {string} [opts.replyStamp] the reply's stable stamp, kept on the history entry
   */
  async afterRequesterReply(ticketId, workspaceId, { now = new Date(), replyStamp = null } = {}) {
    // Two replies a second apart must not both move the ticket.
    const key = Number(ticketId);
    if (this._inFlight.has(key)) return { rerouted: false, reason: 'in_progress' };
    this._inFlight.add(key);
    try {
      const rules = await getRequesterReplyRules(workspaceId);
      if (!rules.rerouteWhenOwnerAway) return { rerouted: false, reason: 'switch_off' };

      const ticket = await prisma.ticket.findFirst({
        where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
        select: {
          id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, status: true,
          isNoise: true, triageMode: true, assignedTechId: true, assignedTech: { select: { id: true, name: true } },
        },
      });
      if (!ticket) return { rerouted: false, reason: 'ticket_not_found' };
      if (!ticket.assignedTechId) return { rerouted: false, reason: 'no_owner' };
      if (ticket.isNoise === true) return { rerouted: false, reason: 'noise' };

      // Only a ticket that is open now: reopened by this reply, or never closed.
      const { default: statusService } = await import('./statusService.js');
      const base = await soft(() => statusService.resolveBaseStatus(ticket.workspaceId, ticket.status), null);
      if (['Resolved', 'Closed'].includes(base)) return { rerouted: false, reason: 'not_open' };

      const exempt = await this.exemptionFor(ticket);
      if (exempt) return { rerouted: false, reason: exempt };

      const absence = await this.absenceFor(ticket.assignedTechId, ticket.workspaceId, { now });
      if (!absence) return { rerouted: false, reason: 'owner_not_away' };
      if (absence.workingDaysAway < MIN_WORKING_DAYS_AWAY) return { rerouted: false, reason: 'back_next_working_day', absence };
      if (await this._alreadyRerouted(ticket.id, ticket.assignedTechId, absence)) return { rerouted: false, reason: 'already_rerouted_this_absence', absence };

      const ownerId = ticket.assignedTechId;
      const ownerName = ticket.assignedTech?.name || 'The owner';
      const until = absence.backOn ? `until ${friendlyDay(absence.backOn)}` : `past ${friendlyDay(absence.lastDay)}`;
      const noteText = `${ownerName} is away ${until}; sent back for assignment after the requester replied.`;

      const { default: ticketService } = await import('./ticketService.js');
      if (ticket.origin === TICKET_ORIGIN.TICKETPULSE) {
        await ticketService.assignTicket(ticket.id, ticket.workspaceId, null, OWNER_AWAY_ACTOR);
      } else {
        await ticketService.updateFsTicket(ticket.id, ticket.workspaceId, {
          assignedTechId: null,
          handBack: { code: 'other', note: noteText },
        }, OWNER_AWAY_ACTOR);
      }

      // The history entry is also the once-per-absence marker. It is written
      // only once the owner is really cleared, so a failed write to
      // FreshService is tried again on the next reply.
      const { default: ticketActivityRepository } = await import('./ticketActivityRepository.js');
      await ticketActivityRepository.create({
        ticketId: ticket.id,
        activityType: OWNER_AWAY_ACTIVITY,
        performedBy: 'Ticket Pulse',
        performedAt: now,
        details: {
          note: noteText,
          actorKind: 'system',
          technicianId: ownerId,
          technicianName: ownerName,
          firstDay: absence.firstDay,
          lastDay: absence.lastDay,
          backOn: absence.backOn,
          workingDaysAway: absence.workingDaysAway,
          ...(replyStamp ? { replyStamp: String(replyStamp) } : {}),
        },
      });

      await soft(() => ticketService.addPrivateNote(ticket.id, ticket.workspaceId, { bodyText: noteText }, OWNER_AWAY_ACTOR, [], { systemNote: true }), null);

      const run = await this._sendForAssignment(ticket, { ownerId, ownerName, noteText, now });
      logger.info(`Owner away: ${ticketDisplayRef(ticket)} taken from ${ownerName} (${until}) and sent for assignment`, {
        ticketId: ticket.id, workspaceId: ticket.workspaceId, technicianId: ownerId, outcome: run?.outcome || null,
      });
      return { rerouted: true, reason: 'owner_away', absence, note: noteText, assignment: run?.outcome || null };
    } catch (err) {
      logger.warn(`Owner-away check failed for ticket ${ticketId} (non-fatal): ${err.message}`);
      return { rerouted: false, reason: 'error', error: err.message };
    } finally {
      this._inFlight.delete(key);
    }
  }

  /** The normal route for a ticket that came back: one assignment run, told who had it and why. */
  async _sendForAssignment(ticket, { ownerId, ownerName, noteText, now }) {
    try {
      const { queueReboundRun } = await import('./reboundRunService.js');
      return await queueReboundRun({
        ticketId: ticket.id,
        workspaceId: ticket.workspaceId,
        freshserviceTicketId: ticket.freshserviceTicketId || null,
        reboundFrom: {
          previousTechId: ownerId,
          previousTechName: ownerName,
          unassignedAt: new Date(now).toISOString(),
          unassignedByName: OWNER_AWAY_ACTOR.name,
          reboundCount: 1,
          source: 'owner_away',
          reason: { code: 'other', label: 'Owner away', note: noteText },
        },
        returnedPhrase: `${ownerName} is away and the requester replied; the ticket was sent back for assignment on ${new Date(now).toISOString().slice(0, 10)}`,
        // FreshService tickets: tie the run to the hand-back row updateFsTicket
        // wrote, so the sync and the hand-back sweep do not route it again.
        onRun: (run) => { this._attachRunToHandBack(ticket, run?.id).catch(() => {}); },
      });
    } catch (err) {
      logger.warn(`Owner away: assignment run could not be queued for ticket ${ticket.id}: ${err.message}`);
      return { outcome: 'failed' };
    }
  }

  async _attachRunToHandBack(ticket, runId) {
    if (!runId || ticket.origin === TICKET_ORIGIN.TICKETPULSE) return;
    const row = await soft(() => prisma.ticketHandBack.findFirst({
      where: { ticketId: ticket.id, origin: 'freshservice', pipelineRunId: null, createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }), null);
    if (row?.id) await soft(() => prisma.ticketHandBack.update({ where: { id: row.id }, data: { pipelineRunId: runId } }), null);
  }
}

export default new OwnerAwayRerouteService();
