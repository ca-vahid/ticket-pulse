import { formatInTimeZone } from 'date-fns-tz';
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import {
  PEOPLE_FIELDS, SETTINGS_FIELDS, URGENT_RESPONSE_MODES,
  addDaysStr, anchorDateFor, normalizeSettings, onCallWeek, rowToSettings, settingsToRow, toDateStr, validateSettings, widensScope,
} from './rules.js';

/**
 * Urgent response — settings (plans/URGENT_RESPONSE_PLAN.md).
 *
 * One row per workspace; no row = the defaults with mode 'off'. Reading never
 * creates a row. Every save is validated, written together with its audit rows
 * (who, when, field, before, after) in one transaction, and puts the engine
 * back to "baseline first" whenever the save brings tickets into scope that
 * were left alone before.
 *
 * New-table reads degrade to "nothing" while the hand-applied migration is
 * missing (soft()).
 */

const FALLBACK_TIMEZONE = 'America/Vancouver';
const MAX_TECHNICIANS = 500;

export const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`Urgent response read degraded: ${err.message}`);
  return fallback;
});

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

class UrgentResponseSettingsService {
  /** The workspace's own time zone (the on-call week and the notices are told in it). */
  async timezone(workspaceId) {
    const ws = await soft(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { defaultTimezone: true } }));
    return ws?.defaultTimezone || FALLBACK_TIMEZONE;
  }

  /**
   * Effective settings: the stored row, else the defaults (mode off).
   *
   * While no on-call order is saved and the old "Requester escalation" page
   * has a weekly rotation, that order (and its start week) comes back as a
   * SUGGESTION — `onCallOrderSuggested: true` — so the admin starts from what
   * they already had. It is not in force until they save. Callers that act on
   * the order (the on-call service, the engine) pass `{ suggest: false }`.
   */
  async getSettings(workspaceId, { suggest = true } = {}) {
    const ws = Number(workspaceId);
    const row = await soft(() => prisma.urgentResponseSettings.findUnique({ where: { workspaceId: ws } }));
    const settings = rowToSettings(row);
    let onCallOrderSuggested = false;
    if (suggest && !settings.onCallOrder.length) {
      const legacy = await this._legacyRotation(ws);
      if (legacy.order.length) {
        settings.onCallOrder = legacy.order;
        if (!settings.onCallAnchorDate && legacy.anchorDate) settings.onCallAnchorDate = legacy.anchorDate;
        onCallOrderSuggested = true;
      }
    }
    return {
      workspaceId: ws,
      ...settings,
      onCallOrderSuggested,
      persisted: Boolean(row),
      baselinedAt: row?.baselinedAt || null,
      updatedBy: row?.updatedBy || null,
      updatedAt: row?.updatedAt || null,
    };
  }

  /** The mode alone — the hot path of the sweep and the pipeline hook (one PK read). */
  async getMode(workspaceId) {
    const row = await soft(() => prisma.urgentResponseSettings.findUnique({ where: { workspaceId: Number(workspaceId) }, select: { mode: true } }));
    return URGENT_RESPONSE_MODES.includes(row?.mode) ? row.mode : 'off';
  }

  /** The weekly rotation of the old after-hours contact, limited to people who are still active here. */
  async _legacyRotation(workspaceId) {
    const policy = await soft(() => prisma.urgentEscalationPolicy.findUnique({
      where: { workspaceId },
      select: { afterHoursRotationOrder: true, afterHoursRotationAnchorDate: true },
    }));
    const ids = [...new Set((Array.isArray(policy?.afterHoursRotationOrder) ? policy.afterHoursRotationOrder : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return { order: [], anchorDate: null };
    const active = await soft(() => prisma.technician.findMany({
      where: { workspaceId, isActive: true, id: { in: ids } },
      select: { id: true },
      take: ids.length,
    }), []);
    const known = new Set(active.map((t) => t.id));
    const order = ids.filter((id) => known.has(id));
    // The old anchor is the instant a week started in the workspace zone.
    let anchorDate = null;
    if (order.length && policy.afterHoursRotationAnchorDate) {
      const tz = await this.timezone(workspaceId);
      anchorDate = await soft(() => formatInTimeZone(policy.afterHoursRotationAnchorDate, tz, 'yyyy-MM-dd'));
    }
    return { order, anchorDate };
  }

  /**
   * Everyone on the workspace's team, for the pickers and for names in the
   * schedule (inactive people stay listed so an old order still reads).
   * Never the photo: it is an 11 KB data URL per row.
   */
  async listTechnicians(workspaceId) {
    return soft(() => prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId) },
      select: { id: true, name: true, email: true, isActive: true, timezone: true, workStartTime: true, workEndTime: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      take: MAX_TECHNICIANS,
    }), []);
  }

  /** The signed-in person's own technician row in this workspace (active, matched by e-mail), or null. */
  async technicianForEmail(workspaceId, email) {
    const address = String(email || '').trim().toLowerCase();
    if (!address) return null;
    return prisma.technician.findFirst({
      where: { workspaceId: Number(workspaceId), isActive: true, email: { equals: address, mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
  }

  /** Is Teams switched on for this workspace (the Rules tab greys the channel out when not)? */
  async teamsEnabled(workspaceId) {
    try {
      const { default: teams } = await import('../teamsNotificationService.js');
      const settings = await teams.workspaceSettings(workspaceId);
      return settings?.teamsEnabled === true;
    } catch (err) {
      logger.debug?.(`Urgent response: Teams state unknown (${err.message})`);
      return false;
    }
  }

  /** Field-level diff for the audit (field, before, after). */
  diffSettings(before, after) {
    const changes = [];
    for (const field of SETTINGS_FIELDS) {
      if (!same(before[field], after[field])) changes.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
    return changes;
  }

  /** Every person the input names must be an active technician of this workspace. */
  async _checkPeople(workspaceId, input, next) {
    const named = [];
    for (const field of PEOPLE_FIELDS) {
      if (input[field] === undefined) continue;
      const ids = Array.isArray(next[field]) ? next[field] : [next[field]];
      for (const id of ids) if (id !== null) named.push({ field, id });
    }
    if (!named.length) return;
    const ids = [...new Set(named.map((n) => n.id))];
    const rows = await prisma.technician.findMany({
      where: { workspaceId, isActive: true, id: { in: ids } },
      select: { id: true },
      take: ids.length,
    });
    const known = new Set(rows.map((r) => r.id));
    const labels = {
      notifyTechnicianIds: 'Who is told', nobodyContactTechnicianId: 'Nobody at work — contact', coordinatorTechnicianId: 'Coordinator', onCallOrder: 'On-call order',
    };
    const bad = named.find((n) => !known.has(n.id));
    if (bad) throw new ValidationError(`${labels[bad.field]}: pick active technicians of this workspace`);
  }

  /**
   * "This person is on call this week": the first-handover date that makes the
   * rotation say so — this week's handover date (the one on or before `now`
   * in the workspace zone) minus one week per place the person sits down the
   * order. An anchor that already puts them on call is kept as it is, so
   * saving the same answer twice changes nothing.
   */
  anchorForCurrent(settings, technicianId, timezone, now) {
    const index = settings.onCallOrder.indexOf(technicianId);
    if (index < 0) throw new ValidationError('On call this week: pick someone who is in the on-call order');
    const saved = toDateStr(settings.onCallAnchorDate);
    if (saved && onCallWeek(settings, timezone, now).technicianId === technicianId) return saved;
    return addDaysStr(anchorDateFor(settings.onCallHandoverDay, settings.onCallHandoverTime, timezone, now), -7 * index);
  }

  /**
   * Save settings (partial input, camelCase). Returns `{ settings, changes }`.
   * `actor` = the session user (`email`, `name`). `now` is injectable for tests.
   *
   * `onCallCurrentTechnicianId` is not a stored field: it says who is on call
   * this week, and is saved (and audited) as the `onCallAnchorDate` it implies.
   */
  async updateSettings(workspaceId, input = {}, actor = null, { now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const body = input && typeof input === 'object' ? input : {};
    // The saved values only: a suggested order is not in force until it is sent back.
    const current = await this.getSettings(ws, { suggest: false });
    const patch = {};
    for (const field of SETTINGS_FIELDS) if (body[field] !== undefined) patch[field] = body[field];
    const before = normalizeSettings(current);
    const next = normalizeSettings({ ...before, ...patch });

    const errors = validateSettings(next);
    if (errors.length) throw new ValidationError(errors[0], errors);
    const rawCurrent = body.onCallCurrentTechnicianId;
    const onCallNow = rawCurrent === undefined || rawCurrent === null || rawCurrent === '' ? null : Number(rawCurrent);
    if (onCallNow !== null && !next.onCallOrder.includes(onCallNow)) {
      throw new ValidationError('On call this week: pick someone who is in the on-call order');
    }
    await this._checkPeople(ws, patch, next);

    if (onCallNow !== null) {
      // Wins over an anchor sent in the same save: the person is the plainer answer.
      next.onCallAnchorDate = this.anchorForCurrent(next, onCallNow, await this.timezone(ws), now);
    } else if (next.onCallOrder.length && !next.onCallAnchorDate) {
      // The first order needs a first handover: the one this week's person started on.
      next.onCallAnchorDate = anchorDateFor(next.onCallHandoverDay, next.onCallHandoverTime, await this.timezone(ws), now);
    }
    next.onCallAnchorDate = toDateStr(next.onCallAnchorDate);

    const changes = this.diffSettings(before, next);
    if (!changes.length && current.persisted) return { settings: await this.getSettings(ws), changes: [] };

    const who = actor?.email || actor?.name || null;
    const data = { ...settingsToRow(next), updatedBy: who };
    // Tickets newly in scope are baselined by the next sweep instead of all being acted on at once.
    if (!current.persisted || widensScope(before, next)) data.baselinedAt = null;
    await prisma.$transaction([
      prisma.urgentResponseSettings.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, ...data }, update: data }),
      ...(changes.length ? [prisma.urgentResponseSettingsChange.createMany({
        // A null side is left out (SQL NULL): Prisma refuses a bare null for a Json column.
        data: changes.map((c) => ({
          workspaceId: ws, changedBy: actor?.email || null, changedByName: actor?.name || null, field: c.field,
          ...(c.before === null ? {} : { before: c.before }),
          ...(c.after === null ? {} : { after: c.after }),
        })),
      })] : []),
    ]);
    logger.info(`Urgent response settings ws ${ws} changed by ${who || 'unknown'}: ${changes.map((c) => c.field).join(', ') || 'first save'}`);
    return { settings: await this.getSettings(ws), changes };
  }

  /** The audit, newest first. `field` is the camelCase key of the settings JSON. */
  async listChanges(workspaceId, { limit = 50 } = {}) {
    const rows = await soft(() => prisma.urgentResponseSettingsChange.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 50, 1), 500),
    }), []);
    return rows.map((r) => ({
      id: r.id,
      changedBy: r.changedBy || null,
      changedByName: r.changedByName || null,
      field: r.field,
      before: r.before ?? null,
      after: r.after ?? null,
      createdAt: r.createdAt,
    }));
  }
}

const urgentResponseSettingsService = new UrgentResponseSettingsService();
export default urgentResponseSettingsService;
export { UrgentResponseSettingsService };
