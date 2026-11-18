/**
 * QA 11-17: two Teams notices that are not about a ticket event.
 *
 *  #3 On-call start. When Settings → Teams "Tell the person on call when their
 *     on-call week starts" is on, the person who takes over the after-hours
 *     rotation (Settings → Urgent Response → On-call) gets ONE message at the
 *     start of their stretch: "You're on call for after-hours support this
 *     week, Mon 16 Nov 5:00 PM PT to Mon 23 Nov 5:00 PM PT." Once per period:
 *     any teams_deliveries row for (workspace, person, 'on_call_start') made
 *     at or after the period start means it was already tried. The person's
 *     own Off is respected; quiet hours and work hours are not applied (the
 *     message marks the start of after-hours).
 *
 *  #4 Survey results. When "Offer survey results" is on, each result (the
 *     Ticket Pulse "How did we do?" survey and FreshService CSAT) goes to the
 *     agent who handled the ticket, and to admins and reviewers who chose
 *     "Everyone's". One result per card: no totals, averages or rankings.
 *
 * Nothing here throws into its callers.
 */
import { formatInTimeZone } from 'date-fns-tz';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import bot from '../integrations/teamsBotClient.js';
import teams, { effectivePrefs } from './teamsNotificationService.js';
import { onCallStartCard, surveyResultCard } from './teamsCards.js';
import { weekSegments } from './urgentResponse/rules.js';
import { timeLabel } from './teamsDigestSlots.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const baseUrl = () => resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });

/** How long after a period starts the notice may still go (the tick is 10 minutes). */
export const ON_CALL_GRACE_MS = 3 * 3600 * 1000;
/** A survey result older than this is history (a first sync or a backfill), not news. */
export const SURVEY_MAX_AGE_MS = 3 * 86400 * 1000;

// ---------------------------------------------------------------- on call (#3)

/**
 * Does somebody's on-call period start now? A period is the first stretch a
 * person holds in a rotation week (the week itself, or a cover's stretch).
 * week: { startsAt, endsAt, technicianId }; covers: raw cover rows.
 * @returns {{ technicianId, startsAt: Date, endsAt: Date, fullWeek: boolean, cover: boolean } | null}
 */
export function onCallPeriodStarting({ week, covers = [], now = new Date(), graceMs = ON_CALL_GRACE_MS } = {}) {
  if (!week?.startsAt || !week?.endsAt) return null;
  const w = { ...week, startsAt: new Date(week.startsAt), endsAt: new Date(week.endsAt) };
  const segments = weekSegments(w, covers);
  const t = now.getTime();
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const start = s.startsAt.getTime();
    if (t < start || t >= Math.min(start + graceMs, s.endsAt.getTime())) continue;
    if (!s.technicianId) return null;
    // A person who already held a stretch this week was told then.
    if (segments.slice(0, i).some((p) => p.technicianId === s.technicianId)) return null;
    return {
      technicianId: s.technicianId,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      fullWeek: start === w.startsAt.getTime() && s.endsAt.getTime() === w.endsAt.getTime(),
      cover: s.cover === true,
    };
  }
  return null;
}

/** "Mon 16 Nov 5:00 PM PT" in the workspace zone. */
export function onCallMoment(at, tz = 'America/Vancouver') {
  const d = new Date(at);
  return `${formatInTimeZone(d, tz, 'EEE d MMM')} ${timeLabel(formatInTimeZone(d, tz, 'HH:mm'), tz)}`;
}

/** The sentence the on-call person gets. */
export function onCallSentence(period, tz = 'America/Vancouver') {
  const from = onCallMoment(period.startsAt, tz);
  const to = onCallMoment(period.endsAt, tz);
  return period.fullWeek
    ? `You're on call for after-hours support this week, ${from} to ${to}.`
    : `You're on call for after-hours support from ${from} to ${to}.`;
}

// ---------------------------------------------------------------- surveys (#4)

/**
 * Who hears about one survey result. Pure.
 *   people: [{ technicianId, prefs, privileged }]  (prefs = effective prefs)
 *   assignedTechId: who handled the ticket
 * The handler hears with "Mine" or "Everyone's"; anybody else only with
 * "Everyone's", and only when privileged (admin or reviewer).
 * @returns {Array<{ technicianId, why: 'mine'|'all', mode }>}
 */
export function surveyAudience({ people = [], assignedTechId = null } = {}) {
  const out = [];
  for (const p of people) {
    const mode = p.prefs?.events?.survey_result;
    if (!mode || mode === 'off') continue;
    if (assignedTechId && p.technicianId === Number(assignedTechId)) {
      out.push({ technicianId: p.technicianId, why: 'mine', mode });
    } else if (p.privileged && p.prefs?.options?.surveyScope === 'all') {
      out.push({ technicianId: p.technicianId, why: 'all', mode });
    }
  }
  return out;
}

/** "Great · 5 of 5" for the summary line (same words as the card). */
function ratingWords({ ratingLabel, score, outOf }) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return ratingLabel || 'Answered';
  return `${ratingLabel ? `${ratingLabel} · ` : ''}${n} of ${Number(outOf) || 5}`;
}

class TeamsExtraNotices {
  // ---- on call -----------------------------------------------------------

  /** Every workspace with Teams and the on-call switch on. Never throws. */
  async runOnCallNotices(now = new Date()) {
    const out = [];
    try {
      if (!bot.isTeamsConfigured()) return out;
      const rows = await prisma.notificationWorkspaceSetting.findMany({ where: { teamsEnabled: true }, select: { workspaceId: true, defaults: true } });
      for (const r of rows || []) {
        if (r.defaults?.extras?.onCallNotice !== true) continue;
        out.push({ workspaceId: r.workspaceId, ...(await this.onCallNoticeFor(r.workspaceId, now)) });
      }
    } catch (err) {
      logger.warn(`Teams on-call notices: ${err.message}`);
    }
    return out;
  }

  async _onCall() {
    const { default: onCall } = await import('./urgentResponse/onCallService.js');
    return onCall;
  }

  /** One workspace. @returns {{ sent?: true, skipped?: string, technicianId?: number }} */
  async onCallNoticeFor(workspaceId, now = new Date()) {
    const ws = Number(workspaceId);
    try {
      const settings = await teams.workspaceSettings(ws);
      if (!settings.teamsEnabled || !settings.onCallNotice) return { skipped: 'off' };
      const onCall = await this._onCall();
      const plan = await onCall.schedule(ws, { from: now, weeks: 1 });
      if (!plan?.configured || !plan.weeks?.length) return { skipped: 'no_rotation' };
      const w = plan.weeks[0];
      const week = { startsAt: w.startsAt, endsAt: w.endsAt, technicianId: w.scheduled?.id ?? null };
      const covers = (w.covers || []).map((c) => ({ id: c.id, coverTechnicianId: c.technician?.id ?? null, startsAt: c.startsAt, endsAt: c.endsAt }));
      const period = onCallPeriodStarting({ week, covers, now });
      if (!period) return { skipped: 'not_starting' };
      // The same person right before this period (e.g. a cover from Sunday
      // across the Monday handover) is one continuous stretch: they were told
      // when it began. A failed look-up does not block the message.
      const before = await Promise.resolve()
        .then(() => onCall.current(ws, new Date(new Date(period.startsAt).getTime() - 1)))
        .catch(() => null);
      if (before?.technician?.id && Number(before.technician.id) === Number(period.technicianId)) {
        return { skipped: 'continuing', technicianId: period.technicianId };
      }

      const tech = await prisma.technician.findFirst({
        where: { id: period.technicianId, workspaceId: ws, isActive: true },
        select: { id: true, name: true, email: true },
      });
      if (!tech?.email) return { skipped: 'no_person', technicianId: period.technicianId };
      const prefs = await teams._prefsFor(ws, tech.id, settings);
      if (prefs.events.on_call_start === 'off') return { skipped: 'person_off', technicianId: tech.id };

      // Once per period: any attempt since the period started counts (sent,
      // e-mailed, skipped as disconnected, failed). A read that fails says "already".
      const already = await Promise.resolve()
        .then(() => prisma.teamsDelivery.findFirst({ where: { workspaceId: ws, technicianId: tech.id, eventKey: 'on_call_start', createdAt: { gte: period.startsAt } }, select: { id: true } }))
        .catch(() => ({ id: -1 }));
      if (already) return { skipped: 'already', technicianId: tech.id };

      const tz = plan.timezone || 'America/Vancouver';
      const sentence = onCallSentence(period, tz);
      const refKey = `oncall:${ws}:${tech.id}:${period.startsAt.toISOString()}`;
      try {
        // Straight to _send: no quiet hours, no work hours (QA 11-17 #3).
        const activityId = await teams._send(tech.email, onCallStartCard({ sentence, url: `${baseUrl()}/on-call` }), {
          summary: sentence, workspaceId: ws, technicianId: tech.id, eventKey: 'on_call_start', refKey,
        });
        return activityId === null ? { skipped: 'not_delivered', technicianId: tech.id } : { sent: true, technicianId: tech.id };
      } catch (err) {
        logger.warn(`Teams on-call notice to technician ${tech.id} failed: ${err.message}`);
        await teams._record({ workspaceId: ws, email: tech.email, technicianId: tech.id, eventKey: 'on_call_start', status: 'failed', reason: String(err.message || 'send failed').slice(0, 120), summary: sentence });
        return { skipped: 'failed', technicianId: tech.id };
      }
    } catch (err) {
      logger.warn(`Teams on-call notice for workspace ${ws} skipped: ${err.message}`);
      return { skipped: 'error' };
    }
  }

  // ---- surveys -----------------------------------------------------------

  /** Fire-and-forget from the survey and CSAT paths. Never throws. */
  notifySurveyResult(input) {
    this._notifySurveyResult(input).catch((err) => logger.warn(`Teams survey result notice skipped: ${err.message}`));
  }

  /**
   * input: { ticketId | freshserviceTicketId, source: 'ticketpulse'|'freshservice',
   *          score, outOf, ratingLabel, comment, updated, submittedAt, resultKey, now }
   * @returns {{ sent: number, held: number, skipped: Array<{ technicianId, why }>, off?: string }}
   */
  async _notifySurveyResult({
    ticketId = null, freshserviceTicketId = null, source = 'ticketpulse', score = null, outOf = 5, ratingLabel = null,
    comment = null, updated = false, submittedAt = null, resultKey = null, now = new Date(),
  } = {}) {
    const out = { sent: 0, held: 0, skipped: [] };
    if (!bot.isTeamsConfigured()) return { ...out, off: 'not_configured' };
    // A FreshService CSAT found by a script (backfill) is not news: only the running app tells.
    if (source === 'freshservice' && !teams.isRunning()) return { ...out, off: 'not_in_app' };
    if (submittedAt && now.getTime() - new Date(submittedAt).getTime() > SURVEY_MAX_AGE_MS) return { ...out, off: 'old' };

    const where = ticketId ? { id: Number(ticketId) } : (freshserviceTicketId ? { freshserviceTicketId: BigInt(freshserviceTicketId) } : null);
    if (!where) return { ...out, off: 'no_ticket' };
    const ticket = await prisma.ticket.findFirst({
      where,
      select: {
        id: true, workspaceId: true, subject: true, freshserviceTicketId: true, nativeNumber: true, origin: true, assignedTechId: true,
        requester: { select: { name: true } },
      },
    });
    if (!ticket) return { ...out, off: 'no_ticket' };
    const ws = await teams.workspaceSettings(ticket.workspaceId);
    if (!ws.teamsEnabled || !ws.surveyResults) return { ...out, off: 'off' };

    const people = await this._surveyPeople(ticket, ws);
    const audience = surveyAudience({ people, assignedTechId: ticket.assignedTechId });
    if (!audience.length) return out;
    const byId = new Map(people.map((p) => [p.technicianId, p]));
    const agentName = ticket.assignedTechId ? (byId.get(ticket.assignedTechId)?.tech?.name
      || (await prisma.technician.findFirst({ where: { id: ticket.assignedTechId }, select: { name: true } }).catch(() => null))?.name || null) : null;
    const ref = ticketDisplayRef(ticket);
    const url = `${baseUrl()}/tickets/${ticket.id}`;
    const card = surveyResultCard({ ratingLabel, score, outOf, comment, ref, subject: ticket.subject, url, agentName, requesterName: ticket.requester?.name || null, source, updated });
    const rating = ratingWords({ ratingLabel, score, outOf });
    const summary = `${[ref, ticket.subject].filter(Boolean).join(' ')} — ${rating}${agentName ? ` · ${agentName}` : ''}`;
    const refKey = `survey:${source === 'freshservice' ? 'fs' : 'tp'}:${ticket.id}:${resultKey ?? score ?? ''}`.slice(0, 120);

    for (const a of audience) {
      const p = byId.get(a.technicianId);
      const tech = p.tech;
      const base = { workspaceId: ticket.workspaceId, email: tech.email, technicianId: tech.id, ticketId: ticket.id, eventKey: 'survey_result', summary };
      // A handler already told by "The requester rates my ticket" is not told twice.
      if (a.why === 'mine' && source === 'ticketpulse' && p.prefs.events.survey_response !== 'off') {
        out.skipped.push({ technicianId: tech.id, why: 'told_as_survey_response' });
        continue;
      }
      const already = await Promise.resolve()
        .then(() => prisma.teamsDelivery.findFirst({ where: { email: lc(tech.email), eventKey: 'survey_result', status: { in: ['sent', 'digest', 'emailed'] }, reason: refKey }, select: { id: true } }))
        .catch(() => null);
      if (already) { out.skipped.push({ technicianId: tech.id, why: 'already' }); continue; }
      const mute = await prisma.ticketNotificationMute.findUnique({ where: { technicianId_ticketId: { technicianId: tech.id, ticketId: ticket.id } } }).catch(() => null);
      if (mute && mute.until > now) { await teams._record({ ...base, status: 'skipped', reason: 'muted' }); out.skipped.push({ technicianId: tech.id, why: 'muted' }); continue; }
      if (a.mode === 'digest') {
        await teams._record({ ...base, status: 'digest', reason: refKey });
        out.held += 1;
        continue;
      }
      // A survey result is never urgent: the person's away and quiet-hours rules apply.
      if (p.prefs.options.respectAway) {
        const away = await teams._awayReason(tech, ticket.workspaceId);
        if (away) { await teams._record({ ...base, status: 'skipped', reason: away }); out.skipped.push({ technicianId: tech.id, why: away }); continue; }
      }
      if (await teams._inQuietHours(tech)) { await teams._record({ ...base, status: 'skipped', reason: 'quiet_hours' }); out.skipped.push({ technicianId: tech.id, why: 'quiet_hours' }); continue; }
      try {
        const activityId = await teams._send(tech.email, card, { summary, workspaceId: ticket.workspaceId, technicianId: tech.id, ticketId: ticket.id, eventKey: 'survey_result', refKey });
        if (activityId === null) out.skipped.push({ technicianId: tech.id, why: 'not_delivered' });
        else out.sent += 1;
      } catch (err) {
        logger.warn(`Teams survey result to technician ${tech.id} failed: ${err.message}`);
        await teams._record({ ...base, status: 'failed', reason: String(err.message || 'send failed').slice(0, 120) });
        out.skipped.push({ technicianId: tech.id, why: 'failed' });
      }
    }
    return out;
  }

  /**
   * The people who might hear: the handler, and everybody in the workspace
   * whose own choice is "Everyone's" (their privilege is checked here, every
   * time, so a role taken away stops the notices).
   * @returns {Array<{ technicianId, tech, prefs, privileged }>}
   */
  async _surveyPeople(ticket, ws) {
    const people = [];
    const select = { id: true, name: true, email: true, timezone: true, workStartTime: true, workEndTime: true, workspaceId: true };
    if (ticket.assignedTechId) {
      const tech = await prisma.technician.findFirst({ where: { id: ticket.assignedTechId, workspaceId: ticket.workspaceId, isActive: true }, select }).catch(() => null);
      if (tech?.email) {
        const prefs = await teams._prefsFor(ticket.workspaceId, tech.id, ws);
        people.push({ technicianId: tech.id, tech, prefs, privileged: false });
      }
    }
    const rows = await Promise.resolve()
      .then(() => prisma.notificationPreference.findMany({ where: { workspaceId: ticket.workspaceId } }))
      .catch(() => []) || [];
    for (const row of rows) {
      if (row.technicianId === ticket.assignedTechId) continue;
      const prefs = effectivePrefs(ws.defaults, row);
      if (prefs.events.survey_result === 'off' || prefs.options.surveyScope !== 'all') continue;
      const tech = await prisma.technician.findFirst({ where: { id: row.technicianId, workspaceId: ticket.workspaceId, isActive: true }, select }).catch(() => null);
      if (!tech?.email) continue;
      const privileged = await teams._canSeeAllSurveys(tech.email, ticket.workspaceId);
      people.push({ technicianId: tech.id, tech, prefs, privileged });
    }
    return people;
  }
}

const teamsExtraNotices = new TeamsExtraNotices();
export default teamsExtraNotices;
export { TeamsExtraNotices };
