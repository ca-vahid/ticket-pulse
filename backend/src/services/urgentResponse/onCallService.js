import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import settingsService, { soft } from './settingsService.js';
import {
  coversInWindow, leaveDaysInWindow, localParts, onCallUntil, onCallWeek, rangeLabel, resolveOnCall,
  sentenceFor, uncoveredLeaveDays, upcomingWeeks,
} from './rules.js';

/**
 * Urgent response — on-call (plans/URGENT_RESPONSE_PLAN.md).
 *
 * A weekly rotation of existing agents: the order, the handover day and time
 * live in the settings row; a COVER hands a week (or part of one) to somebody
 * else without touching the long-term order. The on-call person on leave is
 * never skipped automatically: the week is flagged "needs cover" and an admin
 * either sets the cover or sends a cover REQUEST to the rest of the rotation —
 * the first to accept takes it.
 *
 * Works whatever the mode is (the after-hours phone shown to requesters reads
 * it too). Only a SAVED order counts, never the suggested one.
 *
 * Notices go through ./notifier.js (imported lazily; it never throws, and a
 * missing or failing notifier never fails the action). Every cover action is
 * one urgent_response_actions row with layer 'on_call'.
 */

const COVER_CHANNELS = Object.freeze(['teams', 'email']);
const MAX_COVER_DAYS = 60;
const MAX_WEEKS = 26;
const DAY_MS = 24 * 60 * 60 * 1000;
const COVER_SELECT = {
  id: true, workspaceId: true, originalTechnicianId: true, coverTechnicianId: true, startsAt: true, endsAt: true,
  note: true, source: true, requestId: true, createdBy: true, createdAt: true, cancelledAt: true,
};
const LEAVE_SELECT = {
  technicianId: true, leaveDate: true, category: true, status: true, isFullDay: true, halfDayPart: true, startMinute: true, endMinute: true,
};

const person = (map, id) => (id === null || id === undefined ? null : { id, name: map.get(id)?.name || `Technician ${id}` });
const listOf = (v) => (Array.isArray(v) ? v : []);

function instant(value, label) {
  const d = value instanceof Date ? value : new Date(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(d.getTime())) throw new ValidationError(`${label}: give a date and time`);
  return d;
}

function positiveId(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label}: pick a person`);
  return n;
}

class UrgentResponseOnCallService {
  // ---- shared reads --------------------------------------------------------

  /** The saved settings (never the suggested order) and the workspace zone. */
  async _context(workspaceId) {
    const settings = await settingsService.getSettings(workspaceId, { suggest: false });
    const timezone = await settingsService.timezone(workspaceId);
    return { settings, timezone };
  }

  /** id → { id, name, email } for the people named in a schedule. Never the photo. */
  async _people(workspaceId, ids) {
    const wanted = [...new Set(listOf(ids).filter((id) => Number.isInteger(id) && id > 0))];
    if (!wanted.length) return new Map();
    const rows = await soft(() => prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId), id: { in: wanted } },
      select: { id: true, name: true, email: true, isActive: true },
      take: wanted.length,
    }), []);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async _covers(workspaceId, startsAt, endsAt) {
    return soft(() => prisma.urgentResponseOnCallCover.findMany({
      where: { workspaceId: Number(workspaceId), cancelledAt: null, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      select: COVER_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 200,
    }), []);
  }

  /** Approved leave rows of some people around a window (one day of slack either side for the zone). */
  async _leaves(technicianIds, startsAt, endsAt) {
    const ids = [...new Set(listOf(technicianIds).filter(Boolean))];
    if (!ids.length) return [];
    return soft(() => prisma.technicianLeave.findMany({
      where: {
        technicianId: { in: ids },
        status: 'APPROVED',
        leaveDate: { gte: new Date(startsAt.getTime() - 2 * DAY_MS), lte: new Date(endsAt.getTime() + DAY_MS) },
      },
      select: LEAVE_SELECT,
      take: 2000,
    }), []);
  }

  _coverJson(cover, people) {
    return {
      id: cover.id,
      technician: person(people, cover.coverTechnicianId),
      original: person(people, cover.originalTechnicianId),
      startsAt: cover.startsAt,
      endsAt: cover.endsAt,
      note: cover.note || null,
      source: cover.source,
      requestId: cover.requestId ?? null,
    };
  }

  _requestJson(request, people) {
    const responses = listOf(request.responses);
    return {
      id: request.id,
      original: person(people, request.originalTechnicianId),
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      message: request.message || null,
      status: request.status,
      askedTechnicianIds: listOf(request.askedTechnicianIds),
      askedCount: listOf(request.askedTechnicianIds).length,
      declinedCount: responses.filter((r) => r?.answer === 'decline').length,
      filledBy: person(people, request.filledByTechnicianId),
      filledAt: request.filledAt || null,
      createdBy: request.createdBy || null,
      createdAt: request.createdAt || null,
    };
  }

  // ---- notices and the log -------------------------------------------------

  /** The engine's notifier, imported lazily (it pulls in Teams and mail; tests replace this loader). */
  async _notifier() {
    const { default: notifier } = await import('./notifier.js');
    return notifier;
  }

  /** Tell people; the notifier may not be there yet, and a notice never fails the action. Never throws. */
  async _tell({ workspaceId, technicianIds, title, lines, refKey, link }) {
    const ids = [...new Set(listOf(technicianIds).filter(Boolean))];
    if (!ids.length) return null;
    try {
      const notifier = await this._notifier();
      return await notifier.tellPeople({
        workspaceId, technicianIds: ids, title, lines, ticket: null, refKey, channels: [...COVER_CHANNELS], link,
      });
    } catch (err) {
      logger.warn(`Urgent response: on-call notice not sent (${refKey}): ${err.message}`);
      return null;
    }
  }

  /** One log row. Returns the row, null when it could not be written, 'duplicate' when the dedupe key exists. */
  async _log(action, { workspaceId, from = null, to = null, sentence, details = null, dedupeKey = null }) {
    try {
      const row = await prisma.urgentResponseAction.create({
        data: {
          workspaceId: Number(workspaceId),
          ticketId: null,
          layer: 'on_call',
          action,
          shadow: false,
          priority: null,
          fromTechnicianId: from?.id ?? null,
          toTechnicianId: to?.id ?? null,
          fromName: from?.name ?? null,
          toName: to?.name ?? null,
          sentence,
          ...(details ? { details } : {}),
          dedupeKey,
        },
      });
      logger.info(`Urgent response: ${sentence} (workspace ${workspaceId})`);
      return row;
    } catch (err) {
      if (err?.code === 'P2002') return 'duplicate';
      logger.warn(`Urgent response: could not log ${action} for workspace ${workspaceId}: ${err.message}`);
      return null;
    }
  }

  // ---- the schedule --------------------------------------------------------

  /**
   * The next weeks of the rotation, the first being the week that holds `from`.
   * @returns {{ timezone, handoverDay, handoverTime, configured, order: number[], weeks: object[] }}
   *   week: { index, startsAt, endsAt, scheduled: {id,name}|null, covers: [{ id, technician, startsAt, endsAt, note, source }],
   *           leaveDays: ['yyyy-MM-dd'], needsCover, openRequest: { id, status, askedCount, declinedCount }|null }
   */
  async schedule(workspaceId, { from = new Date(), weeks = 8 } = {}) {
    const ws = Number(workspaceId);
    const { settings, timezone } = await this._context(ws);
    const count = Math.min(Math.max(Number(weeks) || 8, 1), MAX_WEEKS);
    const base = {
      timezone, handoverDay: settings.onCallHandoverDay, handoverTime: settings.onCallHandoverTime, configured: settings.onCallOrder.length > 0, order: settings.onCallOrder,
    };
    if (!settings.onCallOrder.length) return { ...base, weeks: [] };

    const list = upcomingWeeks(settings, timezone, from, count);
    const first = list[0].startsAt;
    const last = list[list.length - 1].endsAt;
    const covers = await this._covers(ws, first, last);
    const scheduledIds = [...new Set(list.map((w) => w.technicianId))];
    const leaves = await this._leaves(scheduledIds, first, last);
    const requests = await soft(() => prisma.urgentResponseCoverRequest.findMany({
      where: { workspaceId: ws, status: 'open', startsAt: { lt: last }, endsAt: { gt: first } },
      orderBy: { id: 'desc' },
      take: 50,
    }), []);
    const people = await this._people(ws, [...scheduledIds, ...covers.map((c) => c.coverTechnicianId)]);

    return {
      ...base,
      weeks: list.map((week) => {
        const mine = coversInWindow(covers, week.startsAt, week.endsAt);
        const leaveDays = leaveDaysInWindow(leaves.filter((l) => l.technicianId === week.technicianId), week.startsAt, week.endsAt, timezone);
        const open = requests.find((r) => r.originalTechnicianId === week.technicianId && r.startsAt < week.endsAt && r.endsAt > week.startsAt) || null;
        return {
          index: week.index,
          startsAt: week.startsAt,
          endsAt: week.endsAt,
          scheduled: person(people, week.technicianId),
          covers: mine.map((c) => {
            const { id, technician, startsAt, endsAt, note, source } = this._coverJson(c, people);
            return { id, technician, startsAt, endsAt, note, source };
          }),
          leaveDays,
          needsCover: uncoveredLeaveDays(leaveDays, mine, week.startsAt, week.endsAt, timezone).length > 0,
          openRequest: open ? {
            id: open.id, status: open.status, askedCount: listOf(open.askedTechnicianIds).length, declinedCount: listOf(open.responses).filter((r) => r?.answer === 'decline').length,
          } : null,
        };
      }),
    };
  }

  /**
   * Who holds on-call at `at`.
   * @returns {{ configured, timezone, technician: {id,name,email}|null, scheduled: {id,name}|null, cover: object|null, until: Date|null, onLeaveNoCover: boolean, week: object|null }}
   *   `configured: false` (everything else null) while no order is saved.
   *   `onLeaveNoCover`: the scheduled person has a full day of leave today and nobody covers — the engine holds instead of texting them.
   */
  async current(workspaceId, at = new Date()) {
    const ws = Number(workspaceId);
    const { settings, timezone } = await this._context(ws);
    if (!settings.onCallOrder.length) {
      return { configured: false, timezone, technician: null, scheduled: null, cover: null, until: null, onLeaveNoCover: false, week: null };
    }
    const week = onCallWeek(settings, timezone, at);
    const covers = await this._covers(ws, week.startsAt, week.endsAt);
    const held = resolveOnCall(week, covers, at);
    const people = await this._people(ws, [held.technicianId, held.scheduledTechnicianId, held.cover?.originalTechnicianId]);
    let onLeaveNoCover = false;
    if (!held.cover) {
      const leaves = await this._leaves([held.scheduledTechnicianId], at, at);
      onLeaveNoCover = leaveDaysInWindow(leaves, at, new Date(at.getTime() + 1), timezone).length > 0;
    }
    const holder = people.get(held.technicianId);
    return {
      configured: true,
      timezone,
      technician: held.technicianId ? { id: held.technicianId, name: holder?.name || `Technician ${held.technicianId}`, email: holder?.email || null } : null,
      scheduled: person(people, held.scheduledTechnicianId),
      cover: held.cover ? this._coverJson(held.cover, people) : null,
      until: onCallUntil(week, covers, at),
      onLeaveNoCover,
      week: { index: week.index, startsAt: week.startsAt, endsAt: week.endsAt },
    };
  }

  // ---- covers --------------------------------------------------------------

  /** Both people must belong to the workspace; the cover must be active. */
  async _coverPeople(workspaceId, originalTechnicianId, coverTechnicianId) {
    const original = positiveId(originalTechnicianId, 'Who is being covered');
    const cover = positiveId(coverTechnicianId, 'Who covers');
    if (original === cover) throw new ValidationError('The cover must be somebody else');
    const people = await this._people(workspaceId, [original, cover]);
    if (!people.get(original)) throw new ValidationError('Who is being covered: pick a technician of this workspace');
    if (!people.get(cover)?.isActive) throw new ValidationError('Who covers: pick an active technician of this workspace');
    return { original: people.get(original), cover: people.get(cover), people };
  }

  _window(startsAt, endsAt) {
    const from = instant(startsAt, 'From');
    const to = instant(endsAt, 'To');
    if (to.getTime() <= from.getTime()) throw new ValidationError('The end must be after the start');
    if (to.getTime() - from.getTime() > MAX_COVER_DAYS * DAY_MS) throw new ValidationError(`A cover can span at most ${MAX_COVER_DAYS} days`);
    return { from, to };
  }

  /**
   * Hand on-call to somebody else for a window. `actor` = the session user.
   * An admin cover may not overlap another one (cancel it first); a cover that
   * comes from an accepted request always goes in.
   */
  async createCover(workspaceId, { originalTechnicianId, coverTechnicianId, startsAt, endsAt, note = null } = {}, actor = null, { source = 'admin', requestId = null, notify = true } = {}) {
    const ws = Number(workspaceId);
    const { from, to } = this._window(startsAt, endsAt);
    const { original, cover, people } = await this._coverPeople(ws, originalTechnicianId, coverTechnicianId);
    if (source !== 'request') {
      const clash = await prisma.urgentResponseOnCallCover.findFirst({
        where: { workspaceId: ws, cancelledAt: null, startsAt: { lt: to }, endsAt: { gt: from } },
        select: { id: true },
      });
      if (clash) throw new ConflictError('There is already a cover in that window. Cancel it first.');
    }
    const row = await prisma.urgentResponseOnCallCover.create({
      data: {
        workspaceId: ws,
        originalTechnicianId: original.id,
        coverTechnicianId: cover.id,
        startsAt: from,
        endsAt: to,
        note: String(note ?? '').trim().slice(0, 2000) || null,
        source: source === 'request' ? 'request' : 'admin',
        requestId: requestId ?? null,
        createdBy: actor?.email || actor?.name || null,
      },
      select: COVER_SELECT,
    });
    const timezone = await settingsService.timezone(ws);
    const range = rangeLabel(from, to, timezone);
    const sentence = sentenceFor('cover_set', { from: original.name, to: cover.name, range });
    await this._log('cover_set', {
      workspaceId: ws, from: original, to: cover, sentence, details: { coverId: row.id, requestId: requestId ?? null, source: row.source, startsAt: from, endsAt: to, by: actor?.email || null },
    });
    if (notify) {
      await this._tell({
        workspaceId: ws,
        technicianIds: [cover.id, original.id],
        title: `On-call cover: ${cover.name} for ${original.name}, ${range}`,
        lines: [sentence, ...(row.note ? [`Note: ${row.note}`] : [])],
        refKey: `urgent-cover-set:${row.id}`,
        link: '/on-call',
      });
    }
    return this._coverJson(row, people);
  }

  /** Cancel a cover (the scheduled person holds on-call again). Cancelling twice is not an error. */
  async cancelCover(workspaceId, coverId, actor = null) {
    const ws = Number(workspaceId);
    const row = await prisma.urgentResponseOnCallCover.findFirst({ where: { id: Number(coverId) || 0, workspaceId: ws }, select: COVER_SELECT });
    if (!row) throw new NotFoundError('That cover was not found');
    if (!row.cancelledAt) {
      await prisma.urgentResponseOnCallCover.updateMany({ where: { id: row.id, cancelledAt: null }, data: { cancelledAt: new Date() } });
      logger.info(`Urgent response: on-call cover ${row.id} cancelled by ${actor?.email || actor?.name || 'unknown'} (workspace ${ws})`);
    }
    return { id: row.id, cancelled: true };
  }

  // ---- cover requests ------------------------------------------------------

  /**
   * Ask the rest of the rotation (or `askTechnicianIds`) to take a window.
   * They are told by Teams and e-mail with a link to /on-call?request=<id>.
   */
  async createRequest(workspaceId, { originalTechnicianId, startsAt, endsAt, message = null, askTechnicianIds = null } = {}, actor = null) {
    const ws = Number(workspaceId);
    const { from, to } = this._window(startsAt, endsAt);
    const originalId = positiveId(originalTechnicianId, 'Who needs cover');
    const { settings, timezone } = await this._context(ws);
    const wanted = Array.isArray(askTechnicianIds) && askTechnicianIds.length
      ? askTechnicianIds.map(Number)
      : settings.onCallOrder;
    const candidates = [...new Set(wanted.filter((id) => Number.isInteger(id) && id > 0 && id !== originalId))];
    const people = await this._people(ws, [originalId, ...candidates]);
    const original = people.get(originalId);
    if (!original) throw new ValidationError('Who needs cover: pick a technician of this workspace');
    const asked = candidates.filter((id) => people.get(id)?.isActive);
    if (!asked.length) throw new ValidationError('There is nobody to ask: add people to the on-call order, or name who to ask');

    const open = await prisma.urgentResponseCoverRequest.findFirst({
      where: { workspaceId: ws, status: 'open', originalTechnicianId: originalId, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { id: true },
    });
    if (open) throw new ConflictError('Cover has already been asked for in that window');

    const row = await prisma.urgentResponseCoverRequest.create({
      data: {
        workspaceId: ws,
        originalTechnicianId: originalId,
        startsAt: from,
        endsAt: to,
        message: String(message ?? '').trim().slice(0, 2000) || null,
        status: 'open',
        askedTechnicianIds: asked,
        responses: [],
        createdBy: actor?.email || actor?.name || null,
      },
    });
    const range = rangeLabel(from, to, timezone);
    await this._log('cover_requested', {
      workspaceId: ws,
      from: original,
      sentence: sentenceFor('cover_requested', { from: original.name, range, asked: asked.length }),
      details: { requestId: row.id, askedTechnicianIds: asked, startsAt: from, endsAt: to, by: actor?.email || null },
    });
    await this._tell({
      workspaceId: ws,
      technicianIds: asked,
      title: `${original.name} needs on-call cover ${range}. Can you take it?`,
      lines: [
        `${original.name} is on call ${range} and needs someone to cover.`,
        ...(row.message ? [`Message: ${row.message}`] : []),
        'The first person to accept takes it.',
      ],
      refKey: `urgent-cover-request:${row.id}`,
      link: `/on-call?request=${row.id}`,
    });
    return this._requestJson(row, people);
  }

  /**
   * Answer a cover request. The first accept wins (one guarded update); it
   * creates the cover, and the person who asked and the original person are told.
   * `technicianId` must be one of the people asked. Pass `workspaceId` to keep
   * the answer inside the caller's workspace.
   * @returns {{ status: string, cover: object|null }}
   */
  async respond(requestId, technicianId, answer, { workspaceId = null, now = new Date() } = {}) {
    if (!['accept', 'decline'].includes(answer)) throw new ValidationError('Answer with "accept" or "decline"');
    const me = Number(technicianId);
    const request = await prisma.urgentResponseCoverRequest.findUnique({ where: { id: Number(requestId) || 0 } });
    if (!request || (workspaceId !== null && request.workspaceId !== Number(workspaceId))) throw new NotFoundError('That cover request was not found');
    if (!Number.isInteger(me) || !listOf(request.askedTechnicianIds).includes(me)) throw new AuthorizationError('This cover request was not sent to you', 'cover_request_not_yours');
    if (request.status === 'filled') throw new ConflictError('Somebody else has already taken it');
    if (request.status !== 'open') throw new ConflictError('This cover request is no longer open');

    const responses = [...listOf(request.responses).filter((r) => r?.technicianId !== me), { technicianId: me, answer, at: now.toISOString() }];
    const ws = request.workspaceId;

    if (answer === 'decline') {
      const { count } = await prisma.urgentResponseCoverRequest.updateMany({ where: { id: request.id, status: 'open' }, data: { responses } });
      if (!count) throw new ConflictError('This cover request is no longer open');
      const everyoneDeclined = listOf(request.askedTechnicianIds).every((id) => responses.some((r) => r.technicianId === id && r.answer === 'decline'));
      if (everyoneDeclined) await this._tellAsker(request, 'Everyone who was asked said no. The week still needs cover.');
      return { status: 'open', cover: null };
    }

    const { count } = await prisma.urgentResponseCoverRequest.updateMany({
      where: { id: request.id, status: 'open' },
      data: { status: 'filled', filledByTechnicianId: me, filledAt: now, responses },
    });
    if (!count) throw new ConflictError('Somebody else has already taken it');

    const people = await this._people(ws, [me]);
    const cover = await this.createCover(ws, {
      originalTechnicianId: request.originalTechnicianId, coverTechnicianId: me, startsAt: request.startsAt, endsAt: request.endsAt, note: request.message,
    }, { email: people.get(me)?.email || null, name: people.get(me)?.name || null }, { source: 'request', requestId: request.id });
    await this._tellAsker(request, `${people.get(me)?.name || 'Somebody'} took it.`);
    return { status: 'filled', cover };
  }

  /** Tell the admin who sent a request, when they are a technician here (the notifier speaks to technicians). */
  async _tellAsker(request, line) {
    try {
      const asker = await settingsService.technicianForEmail(request.workspaceId, request.createdBy);
      if (!asker) return;
      const people = await this._people(request.workspaceId, [request.originalTechnicianId]);
      const timezone = await settingsService.timezone(request.workspaceId);
      const who = people.get(request.originalTechnicianId)?.name || 'the on-call person';
      await this._tell({
        workspaceId: request.workspaceId,
        technicianIds: [asker.id],
        title: `On-call cover for ${who}, ${rangeLabel(request.startsAt, request.endsAt, timezone)}`,
        lines: [line],
        refKey: `urgent-cover-answer:${request.id}:${line.length}`,
        link: '/on-call',
      });
    } catch (err) {
      logger.warn(`Urgent response: could not tell who asked for cover (request ${request.id}): ${err.message}`);
    }
  }

  async cancelRequest(workspaceId, requestId, actor = null) {
    const ws = Number(workspaceId);
    const row = await prisma.urgentResponseCoverRequest.findFirst({ where: { id: Number(requestId) || 0, workspaceId: ws }, select: { id: true, status: true } });
    if (!row) throw new NotFoundError('That cover request was not found');
    const { count } = await prisma.urgentResponseCoverRequest.updateMany({ where: { id: row.id, status: 'open' }, data: { status: 'cancelled' } });
    if (!count) throw new ConflictError(row.status === 'filled' ? 'Somebody has already taken it' : 'This cover request is no longer open');
    logger.info(`Urgent response: cover request ${row.id} cancelled by ${actor?.email || actor?.name || 'unknown'} (workspace ${ws})`);
    return { id: row.id, status: 'cancelled' };
  }

  /**
   * The open requests waiting for this person's answer.
   * @returns {Array<{ id, original: {id,name}, startsAt, endsAt, message, createdBy }>}
   */
  async requestsFor(technicianId, { workspaceId = null, now = new Date() } = {}) {
    const me = Number(technicianId);
    if (!Number.isInteger(me) || me <= 0) return [];
    const rows = await soft(() => prisma.urgentResponseCoverRequest.findMany({
      where: {
        ...(workspaceId !== null ? { workspaceId: Number(workspaceId) } : {}),
        status: 'open',
        askedTechnicianIds: { has: me },
        endsAt: { gt: now },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
    }), []);
    const waiting = rows.filter((r) => !listOf(r.responses).some((a) => a?.technicianId === me));
    if (!waiting.length) return [];
    const people = await this._people(waiting[0].workspaceId, waiting.map((r) => r.originalTechnicianId));
    return waiting.map((r) => ({
      id: r.id,
      original: person(people, r.originalTechnicianId),
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      message: r.message || null,
      createdBy: r.createdBy || null,
    }));
  }

  // ---- the daily check -----------------------------------------------------

  /**
   * Once a day per week: when this week's or next week's on-call person has
   * leave that nobody covers and no request is open, the coordinator is told
   * and a `cover_needed` row is logged (the dedupe key keeps it to one a day).
   * Requests whose window has passed are closed as expired. Never throws.
   */
  async dailyCoverCheck(workspaceId, now = new Date()) {
    const ws = Number(workspaceId);
    const out = { checked: 0, flagged: [], expired: 0 };
    try {
      const expired = await soft(() => prisma.urgentResponseCoverRequest.updateMany({ where: { workspaceId: ws, status: 'open', endsAt: { lt: now } }, data: { status: 'expired' } }));
      out.expired = expired?.count || 0;

      const plan = await this.schedule(ws, { from: now, weeks: 2 });
      if (!plan.configured) return out;
      const settings = await settingsService.getSettings(ws, { suggest: false });
      const tell = settings.coordinatorTechnicianId ?? settings.nobodyContactTechnicianId ?? null;
      const today = localParts(now, plan.timezone).dateStr;
      for (const week of plan.weeks) {
        out.checked += 1;
        if (!week.needsCover || week.openRequest || !week.scheduled) continue;
        const range = rangeLabel(week.startsAt, week.endsAt, plan.timezone);
        const sentence = sentenceFor('cover_needed', { from: week.scheduled.name, range, days: week.leaveDays });
        const logged = await this._log('cover_needed', {
          workspaceId: ws,
          from: week.scheduled,
          sentence,
          details: { weekIndex: week.index, startsAt: week.startsAt, endsAt: week.endsAt, leaveDays: week.leaveDays, toldTechnicianId: tell },
          dedupeKey: `cover_needed:${ws}:${localParts(week.startsAt, plan.timezone).dateStr}:${today}`,
        });
        // Already said today, or the log is not there: say nothing rather than repeat every run.
        if (!logged || logged === 'duplicate') continue;
        out.flagged.push({ weekIndex: week.index, technicianId: week.scheduled.id, leaveDays: week.leaveDays });
        await this._tell({
          workspaceId: ws,
          technicianIds: tell ? [tell] : [],
          title: `On-call needs cover: ${week.scheduled.name}, ${range}`,
          lines: [sentence, 'Set a cover or ask the rotation in Settings → Urgent Response → On-call.'],
          refKey: `urgent-cover-needed:${ws}:${week.index}:${today}`,
          link: '/settings#urgent-response',
        });
      }
    } catch (err) {
      logger.warn(`Urgent response: daily cover check failed for workspace ${ws}: ${err.message}`);
    }
    return out;
  }
}

const urgentResponseOnCallService = new UrgentResponseOnCallService();
export default urgentResponseOnCallService;
export { UrgentResponseOnCallService };
