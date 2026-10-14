/**
 * Availability → Teams (QA 10-13 #6). The Ticket Pulse bot tells a person, in
 * their own chat with it:
 *
 *   av_submitted         their request was booked, or sent for approval
 *   av_decided           someone approved, denied or cancelled it
 *   av_reminder          their time away starts on their next working day
 *   av_approval_waiting  a request is waiting for their decision
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
import { addDays, dayKey, holidayMatcher, toDay, workingDates } from './availabilityRules.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const TZ = 'America/Vancouver';
const REMINDER_FROM = '14:00';
const REMINDER_UNTIL = '18:00';
const TICK_MS = 30 * 60 * 1000;

export const AV_TEAMS_EVENTS = ['av_submitted', 'av_decided', 'av_reminder', 'av_approval_waiting'];

function localDay(at = new Date()) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(at); } catch { return at.toISOString().slice(0, 10); }
}
function localHHMM(at = new Date()) {
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }).format(at); } catch { return '12:00'; }
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
      select: { id: true, email: true, workspaceId: true, timezone: true },
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
   * @returns {{ sent?: boolean, held?: boolean, skipped?: string, failed?: boolean }}
   */
  async notify(email, eventKey, { title, lines = [], refKey = null, path = '/availability', button = 'Open Availability', icon = '🗓️' } = {}) {
    if (!this.enabled() || !lc(email)) return { skipped: 'off_here' };
    let base = null;
    try {
      const { teams, bot, textCard, base: baseUrl } = await this._deps();
      if (!bot.isTeamsConfigured()) return { skipped: 'not_configured' };
      const target = await this._target(email, teams);
      if (!target) return { skipped: 'teams_off' };
      const { tech, ws } = target;
      const prefs = await teams._prefsFor(tech.workspaceId, tech.id, ws);
      const mode = prefs.events[eventKey];
      if (mode === 'off') return { skipped: 'off' };
      const ref = refKey ? String(refKey).slice(0, 120) : null;
      base = { workspaceId: tech.workspaceId, email: tech.email, technicianId: tech.id, eventKey, summary: title };
      if (ref) {
        const already = await prisma.teamsDelivery.findFirst({ where: { email: lc(tech.email), eventKey, status: { in: ['sent', 'digest'] }, reason: ref }, select: { id: true } }).catch(() => null);
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
      const card = textCard(title, body, [{ type: 'Action.OpenUrl', title: button, url: `${baseUrl}${path}` }], { icon, word: 'Availability' });
      const activityId = await teams._send(tech.email, card, { summary: title, workspaceId: tech.workspaceId, technicianId: tech.id, eventKey, refKey: ref });
      return activityId === null ? { skipped: 'disconnected' } : { sent: true };
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

  start() {
    if (this.timer || !this.enabled()) return;
    this.timer = setInterval(() => this.runReminders().catch((err) => logger.warn(`Availability: Teams reminder run failed: ${err.message}`)), TICK_MS);
    this.timer.unref?.();
  }
}

const availabilityTeams = new AvailabilityTeams();
export default availabilityTeams;
export { AvailabilityTeams };
