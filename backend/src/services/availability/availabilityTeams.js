/**
 * Vacation Pulse → Teams (QA 10-13 #6). (Vacation Pulse is the section people
 * see; the code, tables and /availability URLs keep the old name.) The Ticket
 * Pulse bot tells a person, in their own chat with it:
 *
 *   av_submitted         their request was booked, or sent for approval
 *   av_decided           someone approved, denied or cancelled it
 *   av_reminder          their time away starts on their next working day
 *   av_approval_waiting  a request is waiting for their decision, and (MEGA
 *                        11-14 Part I) one card each working morning at 9:00
 *                        listing every request still waiting for them
 *
 * Each is a row in the person's "What am I told about" grid (Mail & alerts →
 * Teams), on unless they turn it off; Digest holds it for the morning digest.
 * Nobody is messaged unless Teams is on for a workspace they are an active
 * agent in, and quiet hours are kept. E-mail notices are unchanged.
 *
 * Off outside production unless AVAILABILITY_TEAMS=true: a development .env
 * carries the real bot credentials.
 */
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import businessCalendarService from '../businessCalendarService.js';
import { addDays, dayKey, daysBetween, holidayMatcher, toDay, workingDates } from './availabilityRules.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const TZ = 'America/Vancouver';
const REMINDER_FROM = '14:00';
const REMINDER_UNTIL = '18:00';
// Part I: the approver's morning list, in the approver's own time zone. The
// window lets a 30-minute tick catch it, and waits out quiet hours or a shift
// that starts later; after it the day is skipped.
const APPROVER_FROM = '09:00';
const APPROVER_UNTIL = '17:00';
const APPROVER_ROWS = 10;
const URGENT_WITHIN_DAYS = 2;
const TICK_MS = 30 * 60 * 1000;
export const SECTION_NAME = 'Vacation Pulse';

export const AV_TEAMS_EVENTS = ['av_submitted', 'av_decided', 'av_reminder', 'av_approval_waiting'];

function localDay(at = new Date(), tz = TZ) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ }).format(at); } catch { return at.toISOString().slice(0, 10); }
}
function localHHMM(at = new Date(), tz = TZ) {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || TZ }).format(at); } catch { return '12:00'; }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Adaptive Card markdown treats these as syntax; a name may contain them.
const mdSafe = (s) => String(s || '').replace(/([[\]()*_`])/g, '\\$1');

/** How near or past a request's first day is, from the approver's today. */
export function urgencyOf(startDate, todayKey) {
  const d = daysBetween(todayKey, startDate);
  let label = null;
  if (d < -1) label = `Started ${d * -1} days ago`;
  else if (d === -1) label = 'Started yesterday';
  else if (d === 0) label = 'Starts today';
  else if (d === 1) label = 'Starts tomorrow';
  else if (d <= URGENT_WITHIN_DAYS) label = `Starts in ${d} days`;
  return { urgent: d <= URGENT_WITHIN_DAYS, label, daysToStart: d };
}

/** "waiting 3 days" / "waiting 5 hours" since the request arrived. */
export function waitedFor(createdAt, now = new Date()) {
  const h = Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 3600_000));
  return h < 24 ? `waiting ${plural(Math.max(1, h), 'hour')}` : `waiting ${plural(Math.floor(h / 24), 'day')}`;
}

/** Urgent ones first (nearest first), then the rest by first day, then oldest request. */
export function orderForApprover(items) {
  return [...items].sort((a, b) => (Number(b.urgent) - Number(a.urgent))
    || (dayKey(a.startDate) < dayKey(b.startDate) ? -1 : dayKey(a.startDate) > dayKey(b.startDate) ? 1 : 0)
    || (new Date(a.createdAt) - new Date(b.createdAt)));
}
const weekdayName = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' });

class AvailabilityTeams {
  constructor() {
    this.timer = null;
  }

  enabled() {
    return process.env.NODE_ENV === 'production' || process.env.AVAILABILITY_TEAMS === 'true';
  }

  async _deps() {
    const [{ default: teams }, { default: bot }, { textCard }, { resolvePublicBaseUrl }] = await Promise.all([
      import('../teamsNotificationService.js'),
      import('../../integrations/teamsBotClient.js'),
      import('../teamsCards.js'),
      import('../../utils/publicBaseUrl.js'),
    ]);
    return { teams, bot, textCard, base: await resolvePublicBaseUrl({ fallback: 'https://ticketpulse.bgcsaas.com' }) };
  }

  /** The person's agent row in the first workspace that has Teams on, or null. */
  async _target(email, teams) {
    const techs = await prisma.technician.findMany({
      where: { isActive: true, email: { equals: lc(email), mode: 'insensitive' } },
      select: { id: true, name: true, email: true, workspaceId: true, timezone: true, workStartTime: true, workEndTime: true },
      orderBy: { workspaceId: 'asc' },
      take: 20,
    });
    for (const tech of techs) {
      const ws = await teams.workspaceSettings(tech.workspaceId);
      if (ws.teamsEnabled) return { tech, ws };
    }
    return null;
  }

  /**
   * One card to one person. Never throws. refKey makes it once-only.
   * emailFallback (Part C): sends the same notice by e-mail when Teams cannot
   * reach the person (disconnected, blocked by a Teams policy, or paused after
   * blocked sends). target: a { tech, ws } already looked up.
   * @returns {{ sent?: boolean, emailed?: boolean, held?: boolean, skipped?: string, failed?: boolean }}
   */
  async notify(email, eventKey, { title, lines = [], refKey = null, path = '/availability', button = `Open ${SECTION_NAME}`, icon = '🗓️', emailFallback = null, target: known = null } = {}) {
    if (!this.enabled() || !lc(email)) return { skipped: 'off_here' };
    let base = null;
    try {
      const { teams, bot, textCard, base: baseUrl } = await this._deps();
      if (!bot.isTeamsConfigured()) return { skipped: 'not_configured' };
      const target = known || await this._target(email, teams);
      if (!target) return { skipped: 'teams_off' };
      const { tech, ws } = target;
      const prefs = await teams._prefsFor(tech.workspaceId, tech.id, ws);
      const mode = prefs.events[eventKey];
      if (mode === 'off') return { skipped: 'off' };
      const ref = refKey ? String(refKey).slice(0, 120) : null;
      base = { workspaceId: tech.workspaceId, email: tech.email, technicianId: tech.id, eventKey, summary: title };
      if (ref) {
        const already = await prisma.teamsDelivery.findFirst({ where: { email: lc(tech.email), eventKey, status: { in: ['sent', 'digest', 'emailed'] }, reason: ref }, select: { id: true } }).catch(() => null);
        if (already) return { skipped: 'already' };
      }
      const body = lines.filter(Boolean).map(String);
      if (mode === 'digest') {
        await teams._record({ ...base, status: 'digest', ...(ref ? { reason: ref } : {}), summary: [title, body[0]].filter(Boolean).join(' — ') });
        return { held: true };
      }
      if (await teams._inQuietHours(tech)) {
        await teams._record({ ...base, status: 'skipped', reason: 'quiet_hours' });
        return { skipped: 'quiet_hours' };
      }
      const card = textCard(title, body, [{ type: 'Action.OpenUrl', title: button, url: `${baseUrl}${path}` }], { icon, word: SECTION_NAME });
      const outcome = {};
      const activityId = await teams._send(tech.email, card, { summary: title, workspaceId: tech.workspaceId, technicianId: tech.id, eventKey, refKey: ref, ...(emailFallback ? { emailFallback, outcome } : {}) });
      if (activityId !== null) return { sent: true };
      if (outcome.via === 'email') return { emailed: true };
      if (outcome.failed) return { failed: true };
      return { skipped: outcome.skipped || 'disconnected' };
    } catch (err) {
      logger.warn(`Availability: Teams notice (${eventKey}) to ${lc(email)} failed: ${err.message}`);
      if (base) await prisma.teamsDelivery.create({ data: { ...base, email: lc(base.email), status: 'failed', reason: String(err.message || 'send failed').slice(0, 120) } }).catch(() => {});
      return { failed: true };
    }
  }

  /**
   * The working day before time away starts (QA 10-13 #6): one reminder per
   * approved request, in the afternoon. A request booked in Ticket Pulse within
   * the last 12 hours is skipped (the person was just told it is booked).
   */
  async runReminders(now = new Date()) {
    const out = { checked: 0, sent: 0 };
    if (!this.enabled()) return out;
    const hhmm = localHHMM(now);
    if (hhmm < REMINDER_FROM || hhmm >= REMINDER_UNTIL) return out;
    const today = toDay(localDay(now));
    const rows = await prisma.avRequest.findMany({
      where: { status: 'approved', startDate: { gt: today, lte: addDays(today, 5) } },
      select: { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, days: true, hours: true, source: true, createdAt: true },
      orderBy: { startDate: 'asc' },
      take: 500,
    });
    if (!rows.length) return out;
    const [types, people, holidays, { describeRange }] = await Promise.all([
      prisma.avLeaveType.findMany({ select: { id: true, name: true, availability: true, unit: true } }),
      prisma.avPerson.findMany({ where: { email: { in: [...new Set(rows.map((r) => r.email))] } }, select: { email: true, workdays: true } }),
      prisma.holiday.findMany({ where: { workspaceId: null, isEnabled: true }, select: { date: true, isRecurring: true, isEnabled: true }, take: 2000 }),
      import('./availabilityService.js'),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const workdaysOf = new Map(people.map((p) => [p.email, p.workdays]));
    const isHoliday = holidayMatcher(holidays);
    for (const r of rows) {
      const type = typeById.get(r.leaveTypeId);
      if (!type || type.availability === 'NONE') continue;
      if (r.source === 'app' && now.getTime() - new Date(r.createdAt).getTime() < 12 * 3600 * 1000) continue;
      const workdays = workdaysOf.get(r.email);
      // Only on a day the person works, and only when their NEXT working day is the first day away.
      const ahead = workingDates({ startDate: today, endDate: addDays(today, 7), workdays, isHoliday });
      if (ahead[0] !== dayKey(today) || !ahead[1]) continue;
      const first = workingDates({ startDate: r.startDate, endDate: r.endDate, workdays, isHoliday })[0];
      if (!first || first !== ahead[1]) continue;
      out.checked += 1;
      const when = first === dayKey(addDays(today, 1)) ? 'Tomorrow' : weekdayName(first);
      const amount = type.unit === 'hour' ? `${Number(r.hours)} hour${Number(r.hours) === 1 ? '' : 's'}` : `${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'}`;
      const res = await this.notify(r.email, 'av_reminder', {
        title: `${when}: ${type.name}`,
        lines: [`${describeRange(r)} · ${amount}`, type.availability === 'OFF' ? 'Set your automatic reply and hand over anything open before you go.' : null],
        refKey: `av:${r.id}:reminder`,
        icon: '⏰',
      });
      if (res.sent) out.sent += 1;
    }
    if (out.sent) logger.info(`Availability: ${out.sent} Teams reminder(s) sent`);
    return out;
  }

  // ------------------------------------------------------------ Part I: approvers

  /**
   * MEGA 11-14 Part I: one card a day per approver, at 9:00 in the approver's
   * own time zone on their working days, listing every time-away request still
   * waiting for them - urgent ones first. The approvers of a request are found
   * the way the first card found them (availabilityService.approversFor). A
   * request is first listed the working morning after it arrived (or was
   * changed): the first card already told them that day. Once a day per
   * approver: refKey av:approver:<email>:<YYYY-MM-DD>. Teams cannot reach
   * them (disconnected, blocked by a Teams policy): the same list by e-mail.
   */
  async runApproverReminders(now = new Date()) {
    const out = { approvers: 0, sent: 0, emailed: 0, held: 0, skipped: {} };
    if (!this.enabled()) return out;
    const rows = await Promise.resolve().then(() => prisma.avRequest.findMany({
      where: { status: 'pending' },
      select: { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, days: true, hours: true, createdAt: true, updatedAt: true },
      orderBy: { startDate: 'asc' },
      take: 500,
    })).catch(() => []);
    if (!rows?.length) return out;
    const mod = await import('./availabilityService.js');
    const svc = mod.default;
    const approversOf = new Map();
    const byApprover = new Map();
    for (const r of rows) {
      const who = lc(r.email);
      if (!approversOf.has(who)) approversOf.set(who, await Promise.resolve().then(() => svc.approversFor(who, { today: now })).catch(() => []));
      for (const a of approversOf.get(who) || []) {
        const key = lc(a);
        if (!key || key === who) continue; // never your own request
        if (!byApprover.has(key)) byApprover.set(key, []);
        byApprover.get(key).push(r);
      }
    }
    if (!byApprover.size) return out;
    const [types, people, holidays] = await Promise.all([
      Promise.resolve().then(() => prisma.avLeaveType.findMany({ select: { id: true, name: true, unit: true } })).catch(() => []),
      Promise.resolve().then(() => prisma.avPerson.findMany({ where: { email: { in: [...new Set([...rows.map((r) => lc(r.email)), ...byApprover.keys()])] } }, select: { email: true, name: true, workdays: true } })).catch(() => []),
      Promise.resolve().then(() => prisma.holiday.findMany({ where: { isEnabled: true }, select: { date: true, isRecurring: true, isEnabled: true, workspaceId: true }, take: 5000 })).catch(() => []),
    ]);
    const ctx = {
      svc: mod,
      typeById: new Map((types || []).map((t) => [t.id, t])),
      personOf: new Map((people || []).map((p) => [lc(p.email), p])),
      holidays: holidays || [],
    };
    for (const [approver, list] of byApprover) {
      out.approvers += 1;
      const res = await this._remindApprover(approver, list, ctx, now).catch((err) => {
        logger.warn(`Availability: approver reminder for ${approver} failed: ${err.message}`);
        return { failed: true };
      });
      if (res.sent) out.sent += 1;
      else if (res.emailed) out.emailed += 1;
      else if (res.held) out.held += 1;
      else {
        const why = res.skipped || (res.failed ? 'failed' : 'unknown');
        out.skipped[why] = (out.skipped[why] || 0) + 1;
      }
    }
    if (out.sent || out.emailed) logger.info(`Availability: approver reminders: ${out.sent} by Teams, ${out.emailed} by e-mail`);
    return out;
  }

  /** Is `day` (YYYY-MM-DD) a working day for this approver? Their own weekdays, holidays, and the workspace calendar. */
  async _approverWorkingDay(email, day, workspaceId, ctx) {
    const person = ctx.personOf.get(lc(email));
    const isHoliday = holidayMatcher(ctx.holidays.filter((h) => h.workspaceId === null || h.workspaceId === undefined || Number(h.workspaceId) === Number(workspaceId)));
    if (!workingDates({ startDate: day, endDate: day, workdays: person?.workdays, isHoliday }).length) return false;
    const calendar = await businessCalendarService.loadCalendarSafe(Number(workspaceId));
    return businessCalendarService.isWorkingDate(day, calendar);
  }

  async _remindApprover(email, requests, ctx, now) {
    const { teams, bot, base } = await this._deps();
    if (!bot.isTeamsConfigured()) return { skipped: 'not_configured' };
    const target = await this._target(email, teams);
    if (!target) return { skipped: 'teams_off' };
    const { tech, ws } = target;
    const tz = tech.timezone || TZ;
    const hhmm = localHHMM(now, tz);
    if (hhmm < APPROVER_FROM || hhmm >= APPROVER_UNTIL) return { skipped: 'not_now' };
    const today = localDay(now, tz);
    if (!(await this._approverWorkingDay(email, today, tech.workspaceId, ctx))) return { skipped: 'not_a_working_day' };
    const refKey = `av:approver:${lc(email)}:${today}`;
    const already = await prisma.teamsDelivery.findFirst({ where: { email: lc(tech.email), eventKey: 'av_approval_waiting', status: { in: ['sent', 'digest', 'emailed'] }, reason: refKey }, select: { id: true } }).catch(() => null);
    if (already) return { skipped: 'already' };
    const prefs = await teams._prefsFor(tech.workspaceId, tech.id, ws);
    if (prefs.events?.av_approval_waiting === 'off') return { skipped: 'off' };
    // Away today (leave, not working from home): skip the day; the list waits.
    // Before their shift: the next tick tries again.
    const away = await Promise.resolve().then(() => teams._awayReason(tech, tech.workspaceId)).catch(() => null);
    if (away === 'on_leave') return { skipped: 'away' };
    if (away === 'off_shift') return { skipped: 'off_shift' };
    if (await teams._inQuietHours(tech)) return { skipped: 'quiet_hours' };

    // The first card went out the day the request arrived (or was changed).
    const due = requests.filter((r) => {
      const latest = r.updatedAt && new Date(r.updatedAt) > new Date(r.createdAt) ? r.updatedAt : r.createdAt;
      return localDay(new Date(latest), tz) < today;
    });
    if (!due.length) return { skipped: 'first_day' };

    const items = orderForApprover(due.map((r) => ({ ...r, ...urgencyOf(r.startDate, today) })));
    const { describeRange, describeAmount } = ctx.svc;
    const rowFor = (r) => {
      const type = ctx.typeById.get(r.leaveTypeId);
      const who = ctx.personOf.get(lc(r.email))?.name || r.email;
      return {
        who,
        type: type?.name || 'Time away',
        range: describeRange(r),
        amount: describeAmount(r, type),
        waited: waitedFor(r.createdAt, now),
        urgent: r.urgent,
        label: r.label,
      };
    };
    const shown = items.slice(0, APPROVER_ROWS).map(rowFor);
    const more = items.length - shown.length;
    const urgentCount = items.filter((r) => r.urgent).length;
    const title = items.length === 1 ? '1 time-away request is waiting for you' : `${items.length} time-away requests are waiting for you`;
    const lines = [
      ...shown.map((x) => `${x.urgent && x.label ? `**${x.label}** · ` : ''}**${mdSafe(x.who)}** · ${mdSafe(x.type)} · ${x.range} · ${x.amount} · ${x.waited}`),
      more > 0 ? `…and ${more} more` : null,
    ];
    const url = `${base}/availability/approvals`;
    const emailFallback = async () => {
      const { sendEmail } = await import('../sendgridNotificationService.js');
      const html = ctx.svc.emailHtml({
        title,
        lines: [
          ...shown.map((x) => `${x.urgent && x.label ? `${x.label}: ` : ''}${x.who} · ${x.type} · ${x.range} · ${x.amount} · ${x.waited}`),
          more > 0 ? `…and ${more} more` : null,
          'Ticket Pulse could not reach you in Teams, so this came by e-mail.',
        ],
        button: { label: 'Review the requests', url },
      });
      const subject = `${SECTION_NAME}: ${items.length === 1 ? '1 time-away request waits' : `${items.length} time-away requests wait`} for you${urgentCount ? ` (${urgentCount} soon)` : ''}`;
      await sendEmail({ to: [lc(email)], subject, html, context: 'availability' });
      return true;
    };
    return this.notify(email, 'av_approval_waiting', {
      title,
      lines,
      refKey,
      path: '/availability/approvals',
      button: 'Review the requests',
      icon: '🙋',
      emailFallback,
      target,
    });
  }

  /** The 30-minute tick: the day-before reminder, then the approvers' morning list. */
  async tick(now = new Date()) {
    await this.runReminders(now).catch((err) => logger.warn(`Availability: Teams reminder run failed: ${err.message}`));
    await this.runApproverReminders(now).catch((err) => logger.warn(`Availability: approver reminder run failed: ${err.message}`));
  }

  start() {
    if (this.timer || !this.enabled()) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
    this.timer.unref?.();
  }
}

const availabilityTeams = new AvailabilityTeams();
export default availabilityTeams;
export { AvailabilityTeams };
