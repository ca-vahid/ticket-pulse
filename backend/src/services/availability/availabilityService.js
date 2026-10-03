/**
 * Availability (plans/AVAILABILITY_TRACKER_PLAN.md, Oct 2026): the native
 * Vacation Tracker replacement. Company-level, keyed by e-mail.
 *
 * - Requests are decided by the pure rules engine (availabilityRules.js).
 * - Approvers come from hand-made approval groups (no Entra managers).
 * - Approved requests are projected into technician_leaves for every
 *   workspace the person is a technician in, so the dashboard, Analytics and
 *   the AI assignment tools read them unchanged. Keys: 'av:<requestId>:w<ws>'.
 * - Requests imported from Vacation Tracker are not projected into a
 *   workspace whose VT sync is still on (the sync already writes them).
 */
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { ValidationError, NotFoundError, AuthorizationError } from '../../utils/errors.js';
import {
  decide, workingDates, requestSize, holidayMatcher, toDay, dayKey, addDays, weekKey,
  leaveYearOf, leaveYearRange, entitlementFor, RULE_KINDS, RULE_OUTCOMES,
} from './availabilityRules.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const num = (d) => ((d === null || d === undefined) ? 0 : Number(d));
const ACTIVE = ['approved', 'pending'];
const AVAILABILITY_TO_CATEGORY = { OFF: 'OFF', WFH: 'WFH', ONSITE: 'OTHER', PARTIAL: 'OTHER' };

// Defaults seeded on first use. Numbers are placeholders an admin edits under
// Availability → Settings (Vahid to confirm BGC's real entitlements).
export const DEFAULT_LEAVE_TYPES = [
  {
    key: 'vacation', name: 'Vacation', icon: 'palmtree', color: 'emerald', availability: 'OFF', requiresApproval: true, tracksBalance: true,
    balancePolicy: { annualDays: 10, tenureTiers: [{ afterYears: 5, days: 15 }], prorate: true }, sortOrder: 10,
    vtLeaveTypeNames: ['vacation', 'pto', 'paid time off', 'holiday'],
  },
  {
    key: 'sick', name: 'Sick', icon: 'thermometer', color: 'rose', availability: 'OFF', visibility: 'away', requiresApproval: false, allowPastDated: true,
    tracksBalance: true, balancePolicy: { annualDays: 5, eligibleAfterDays: 90 }, sortOrder: 20, vtLeaveTypeNames: ['sick', 'sick day', 'sick leave'],
  },
  { key: 'wfh', name: 'Working from home', icon: 'house', color: 'sky', availability: 'WFH', requiresApproval: false, sortOrder: 30, vtLeaveTypeNames: ['work from home', 'wfh', 'remote', 'working from home'] },
  { key: 'site_visit', name: 'Site visit', icon: 'hard-hat', color: 'amber', availability: 'ONSITE', requiresApproval: false, sortOrder: 40, vtLeaveTypeNames: ['site visit', 'field', 'field work', 'business trip', 'travel'] },
  { key: 'training', name: 'Training / conference', icon: 'graduation-cap', color: 'violet', availability: 'OFF', requiresApproval: true, sortOrder: 50, vtLeaveTypeNames: ['training', 'conference', 'course'] },
  { key: 'appointment', name: 'Appointment', icon: 'clock', color: 'slate', unit: 'hour', allowHalfDays: false, availability: 'OFF', visibility: 'away', requiresApproval: false, allowPastDated: true, sortOrder: 60, vtLeaveTypeNames: ['appointment', 'doctor'] },
  { key: 'bereavement', name: 'Bereavement', icon: 'flower', color: 'slate', availability: 'OFF', visibility: 'away', requiresApproval: true, sortOrder: 70, vtLeaveTypeNames: ['bereavement', 'compassionate'] },
  { key: 'banked', name: 'Banked time', icon: 'piggy-bank', color: 'teal', availability: 'OFF', requiresApproval: true, sortOrder: 80, vtLeaveTypeNames: ['banked', 'in lieu', 'toil', 'overtime'] },
  { key: 'unpaid', name: 'Unpaid leave', icon: 'calendar-x', color: 'slate', availability: 'OFF', requiresApproval: true, sortOrder: 90, vtLeaveTypeNames: ['unpaid'] },
];

class AvailabilityService {
  // ------------------------------------------------------------------ setup

  async getSettings() {
    const row = await prisma.avSettings.findUnique({ where: { id: 1 } });
    return row || prisma.avSettings.create({ data: { id: 1 } });
  }

  async updateSettings(patch, actor) {
    await this.assertAdmin(actor);
    const data = {};
    if ((patch.yearStartMonth !== null && patch.yearStartMonth !== undefined)) {
      const m = Number(patch.yearStartMonth);
      if (!(m >= 1 && m <= 12)) throw new ValidationError('yearStartMonth must be 1–12');
      data.yearStartMonth = m;
    }
    if ((patch.outlookEventsEnabled !== null && patch.outlookEventsEnabled !== undefined)) data.outlookEventsEnabled = Boolean(patch.outlookEventsEnabled);
    if ((patch.autoRepliesEnabled !== null && patch.autoRepliesEnabled !== undefined)) data.autoRepliesEnabled = Boolean(patch.autoRepliesEnabled);
    if (patch.purposeNotice !== undefined) data.purposeNotice = patch.purposeNotice ? String(patch.purposeNotice).slice(0, 2000) : null;
    await this.getSettings();
    return prisma.avSettings.update({ where: { id: 1 }, data });
  }

  /** Seed leave types and offices once; idempotent. */
  async ensureSeed() {
    const count = await prisma.avLeaveType.count();
    if (count === 0) {
      for (const t of DEFAULT_LEAVE_TYPES) {
        await prisma.avLeaveType.upsert({ where: { key: t.key }, update: {}, create: t });
      }
      logger.info(`Availability: seeded ${DEFAULT_LEAVE_TYPES.length} leave types`);
    }
    const offices = await prisma.avOffice.count();
    if (offices === 0) {
      const locs = await prisma.technician.findMany({
        where: { isActive: true, location: { not: null } },
        select: { location: true },
        distinct: ['location'],
        take: 50,
      });
      const names = [...new Set(locs.map((l) => String(l.location || '').trim()).filter(Boolean))];
      for (const name of names) {
        await prisma.avOffice.upsert({ where: { name }, update: {}, create: { name, province: guessProvince(name) } });
      }
      if (names.length) logger.info(`Availability: seeded ${names.length} offices from technician locations`);
    }
    await this.getSettings();
  }

  // ------------------------------------------------------------------ access

  async isAdmin(user) {
    if (!user?.email) return false;
    if (user.role === 'admin') return true;
    const row = await prisma.workspaceAccess.findFirst({ where: { email: lc(user.email), role: 'admin' }, select: { id: true } });
    return Boolean(row);
  }

  async assertAdmin(user) {
    if (!(await this.isAdmin(user))) throw new AuthorizationError('Only administrators can change Availability settings', 'availability_admin');
  }

  /** E-mails of active approvers (incl. delegates active today) of the groups containing `email`. */
  async approversFor(email, { today = new Date() } = {}) {
    const groups = await this._groupsOf(email);
    const out = new Set();
    for (const g of groups) {
      for (const a of g.approvers || []) {
        if (a.isDelegate) {
          const from = a.delegateFrom ? toDay(a.delegateFrom) : null;
          const until = a.delegateUntil ? toDay(a.delegateUntil) : null;
          const t = toDay(today);
          if ((from && t < from) || (until && t > until)) continue;
        }
        if (lc(a.email) !== lc(email)) out.add(lc(a.email));
      }
    }
    if (out.size === 0) {
      // Nobody set up yet: fall back to Ticket Pulse admins so nothing is stuck.
      const admins = await prisma.workspaceAccess.findMany({ where: { role: 'admin' }, select: { email: true }, take: 50 });
      for (const a of admins) if (lc(a.email) !== lc(email)) out.add(lc(a.email));
    }
    return [...out];
  }

  async _groupsOf(email) {
    const rows = await prisma.avApprovalGroupMember.findMany({
      where: { email: lc(email), group: { isActive: true } },
      select: { group: { include: { approvers: true } } },
    });
    return rows.map((r) => r.group);
  }

  async canDecide(user, request) {
    if (!user?.email) return false;
    if (lc(user.email) === lc(request.email)) return false; // no self-approval
    if (await this.isAdmin(user)) return true;
    return (await this.approversFor(request.email)).includes(lc(user.email));
  }

  // ------------------------------------------------------------------ people

  /** Make sure every Ticket Pulse user has a person row (agents + workspace members). */
  async syncPeople() {
    const [techs, access, offices] = await Promise.all([
      prisma.technician.findMany({ where: { isActive: true, email: { not: null } }, select: { email: true, name: true, location: true }, take: 2000 }),
      prisma.workspaceAccess.findMany({ select: { email: true }, take: 2000 }),
      prisma.avOffice.findMany({ select: { id: true, name: true } }),
    ]);
    const officeByName = new Map(offices.map((o) => [lc(o.name), o.id]));
    const byEmail = new Map();
    for (const t of techs) {
      const e = lc(t.email);
      if (!e || byEmail.has(e)) continue;
      byEmail.set(e, { email: e, name: t.name || e, officeId: officeByName.get(lc(t.location)) || null });
    }
    for (const a of access) {
      const e = lc(a.email);
      if (e && !byEmail.has(e)) byEmail.set(e, { email: e, name: e.split('@')[0], officeId: null });
    }
    const existingRows = await prisma.avPerson.findMany({ select: { id: true, email: true, officeId: true } });
    const existing = new Map(existingRows.map((p) => [p.email, p]));
    let created = 0;
    let officesFilled = 0;
    for (const p of byEmail.values()) {
      const row = existing.get(p.email);
      if (row) {
        // Offices come from the person's location (Vahid, 3 Oct 2026); an
        // office an admin set by hand is never overwritten.
        if (!row.officeId && p.officeId) {
          await prisma.avPerson.update({ where: { id: row.id }, data: { officeId: p.officeId } }).catch(() => null);
          officesFilled += 1;
        }
        continue;
      }
      await prisma.avPerson.create({ data: p }).catch(() => null);
      created += 1;
    }
    return { created, officesFilled, total: byEmail.size };
  }

  async ensurePerson(user) {
    const email = lc(user?.email);
    if (!email) throw new AuthorizationError('Sign in first');
    const found = await prisma.avPerson.findUnique({ where: { email } });
    if (found) return found;
    const tech = await prisma.technician.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, isActive: true }, select: { name: true, location: true } });
    let officeId = null;
    if (tech?.location) {
      const office = await prisma.avOffice.findFirst({ where: { name: { equals: tech.location.trim(), mode: 'insensitive' } }, select: { id: true } });
      officeId = office?.id || null;
    }
    return prisma.avPerson.create({ data: { email, name: tech?.name || user.name || email, officeId } });
  }

  async listPeople() {
    return prisma.avPerson.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, email: true, name: true, officeId: true, startDate: true, workdays: true, dailyHours: true, entitlementOverrides: true },
      take: 2000,
    });
  }

  async updatePerson(id, patch, actor) {
    await this.assertAdmin(actor);
    const data = {};
    if (patch.officeId !== undefined) data.officeId = patch.officeId ? Number(patch.officeId) : null;
    if (patch.startDate !== undefined) data.startDate = patch.startDate ? toDay(patch.startDate) : null;
    if (patch.workdays !== undefined) {
      const w = Array.isArray(patch.workdays) ? patch.workdays.map(Number).filter((d) => d >= 1 && d <= 7) : null;
      data.workdays = w && w.length ? w : null;
    }
    if (patch.dailyHours !== undefined) {
      const h = Number(patch.dailyHours);
      if (!(h > 0 && h <= 24)) throw new ValidationError('dailyHours must be between 0 and 24');
      data.dailyHours = h;
    }
    if (patch.isActive !== undefined) data.isActive = Boolean(patch.isActive);
    if (patch.entitlementOverrides !== undefined) {
      const clean = {};
      for (const [k, v] of Object.entries(patch.entitlementOverrides || {})) {
        if (v === null || v === '' || v === undefined) continue;
        const n = Number(v);
        if (!(n >= 0 && n <= 366)) throw new ValidationError('Allowances must be between 0 and 366 days');
        clean[String(Number(k))] = n;
      }
      data.entitlementOverrides = Object.keys(clean).length ? clean : null;
    }
    return prisma.avPerson.update({ where: { id: Number(id) }, data });
  }

  // ------------------------------------------------------------------ catalogue CRUD (admin)

  listOffices() { return prisma.avOffice.findMany({ orderBy: { name: 'asc' } }); }

  async saveOffice(input, actor) {
    await this.assertAdmin(actor);
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationError('Office name is required');
    const data = { name, province: input.province || null, timezone: input.timezone || 'America/Vancouver', isActive: input.isActive !== false };
    return input.id
      ? prisma.avOffice.update({ where: { id: Number(input.id) }, data })
      : prisma.avOffice.create({ data });
  }

  listLeaveTypes({ includeInactive = false } = {}) {
    return prisma.avLeaveType.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async saveLeaveType(input, actor) {
    await this.assertAdmin(actor);
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationError('Leave type name is required');
    const pick = (k, allowed) => ((input[k] !== null && input[k] !== undefined) && allowed.includes(input[k]) ? input[k] : undefined);
    const data = {
      name,
      icon: input.icon || null,
      color: input.color || 'blue',
      unit: pick('unit', ['day', 'hour']),
      allowHalfDays: input.allowHalfDays,
      requiresApproval: input.requiresApproval,
      availability: pick('availability', ['OFF', 'WFH', 'ONSITE', 'PARTIAL', 'NONE']),
      visibility: pick('visibility', ['public', 'away', 'private']),
      requiresNote: input.requiresNote,
      allowPastDated: input.allowPastDated,
      tracksBalance: input.tracksBalance,
      balancePolicy: input.balancePolicy === undefined ? undefined : (input.balancePolicy || null),
      vtLeaveTypeNames: input.vtLeaveTypeNames === undefined ? undefined : (input.vtLeaveTypeNames || null),
      sortOrder: (input.sortOrder !== null && input.sortOrder !== undefined) ? Number(input.sortOrder) : undefined,
      isActive: input.isActive,
    };
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);
    if (input.id) return prisma.avLeaveType.update({ where: { id: Number(input.id) }, data });
    const key = (String(input.key || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'type').slice(0, 40);
    return prisma.avLeaveType.create({ data: { ...data, key } });
  }

  listGroups() {
    return prisma.avApprovalGroup.findMany({ orderBy: { name: 'asc' }, include: { members: true, approvers: true } });
  }

  async saveGroup(input, actor) {
    await this.assertAdmin(actor);
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationError('Group name is required');
    const auto = input.autoApproveTypeIds === '*' || (Array.isArray(input.autoApproveTypeIds) && input.autoApproveTypeIds.includes('*'))
      ? ['*']
      : (Array.isArray(input.autoApproveTypeIds) ? input.autoApproveTypeIds.map(Number).filter(Boolean) : []);
    const data = { name, description: input.description || null, autoApproveTypeIds: auto, requireAll: Boolean(input.requireAll), isActive: input.isActive !== false };
    const group = input.id
      ? await prisma.avApprovalGroup.update({ where: { id: Number(input.id) }, data })
      : await prisma.avApprovalGroup.create({ data });
    if (Array.isArray(input.members)) {
      const emails = [...new Set(input.members.map(lc).filter(Boolean))];
      await prisma.avApprovalGroupMember.deleteMany({ where: { groupId: group.id, email: { notIn: emails } } });
      for (const email of emails) {
        await prisma.avApprovalGroupMember.upsert({ where: { groupId_email: { groupId: group.id, email } }, update: {}, create: { groupId: group.id, email } });
      }
    }
    if (Array.isArray(input.approvers)) {
      const rows = input.approvers.map((a) => (typeof a === 'string' ? { email: a } : a)).filter((a) => lc(a.email));
      const emails = [...new Set(rows.map((a) => lc(a.email)))];
      if (emails.length === 0) throw new ValidationError('An approval group needs at least one approver');
      await prisma.avApprovalGroupApprover.deleteMany({ where: { groupId: group.id, email: { notIn: emails } } });
      for (const a of rows) {
        const email = lc(a.email);
        const d = {
          isDelegate: Boolean(a.isDelegate),
          delegateFrom: a.delegateFrom ? toDay(a.delegateFrom) : null,
          delegateUntil: a.delegateUntil ? toDay(a.delegateUntil) : null,
        };
        await prisma.avApprovalGroupApprover.upsert({ where: { groupId_email: { groupId: group.id, email } }, update: d, create: { groupId: group.id, email, ...d } });
      }
    }
    return prisma.avApprovalGroup.findUnique({ where: { id: group.id }, include: { members: true, approvers: true } });
  }

  async deleteGroup(id, actor) {
    await this.assertAdmin(actor);
    await prisma.avApprovalGroup.delete({ where: { id: Number(id) } });
    return { deleted: true };
  }

  listRules() { return prisma.avRule.findMany({ orderBy: [{ priority: 'asc' }, { id: 'asc' }] }); }

  async saveRule(input, actor) {
    await this.assertAdmin(actor);
    const name = String(input.name || '').trim();
    if (!name) throw new ValidationError('Rule name is required');
    const kind = input.condition?.kind;
    if (!RULE_KINDS.includes(kind)) throw new ValidationError(`Unknown condition "${kind}"`);
    if (!RULE_OUTCOMES.includes(input.outcome)) throw new ValidationError(`Unknown outcome "${input.outcome}"`);
    if (!['company', 'office', 'group', 'person'].includes(input.scopeType || 'company')) throw new ValidationError('Unknown scope');
    if ((input.scopeType || 'company') !== 'company' && !input.scopeRef) throw new ValidationError('Pick the office, group or person this rule is for');
    const data = {
      name,
      scopeType: input.scopeType || 'company',
      scopeRef: input.scopeType && input.scopeType !== 'company' ? String(input.scopeRef) : null,
      leaveTypeIds: Array.isArray(input.leaveTypeIds) && input.leaveTypeIds.length ? input.leaveTypeIds.map(Number) : null,
      condition: input.condition,
      outcome: input.outcome,
      message: input.message || null,
      priority: (input.priority !== null && input.priority !== undefined) ? Number(input.priority) : 100,
      isActive: input.isActive !== false,
    };
    return input.id ? prisma.avRule.update({ where: { id: Number(input.id) }, data }) : prisma.avRule.create({ data });
  }

  async deleteRule(id, actor) {
    await this.assertAdmin(actor);
    await prisma.avRule.delete({ where: { id: Number(id) } });
    return { deleted: true };
  }

  // ------------------------------------------------------------------ requests

  async _holidays() {
    return prisma.holiday.findMany({ where: { workspaceId: null, isEnabled: true }, select: { date: true, isRecurring: true, isEnabled: true }, take: 2000 });
  }

  /** Normalise input and compute dates/size. Throws ValidationError on bad input. */
  async _shape(person, input) {
    const leaveType = await prisma.avLeaveType.findUnique({ where: { id: Number(input.leaveTypeId) } });
    if (!leaveType || !leaveType.isActive) throw new ValidationError('Pick a leave type');
    const startDate = toDay(input.startDate);
    const endDate = toDay(input.endDate || input.startDate);
    if (!startDate || !endDate) throw new ValidationError('Pick the dates');
    if (endDate < startDate) throw new ValidationError('The end date is before the start date');
    if (daysSpan(startDate, endDate) > 366) throw new ValidationError('A request can cover at most a year');
    let dayPart = ['full', 'am', 'pm', 'hours'].includes(input.dayPart) ? input.dayPart : 'full';
    if (leaveType.unit === 'hour') dayPart = 'hours';
    if ((dayPart === 'am' || dayPart === 'pm') && !leaveType.allowHalfDays) throw new ValidationError(`${leaveType.name} can't be booked as a half day`);
    let startMinute = null;
    let endMinute = null;
    if (dayPart === 'hours') {
      startMinute = Number(input.startMinute);
      endMinute = Number(input.endMinute);
      if (!(startMinute >= 0 && endMinute <= 24 * 60 && endMinute > startMinute)) throw new ValidationError('Pick a start and end time');
    }
    if (leaveType.requiresNote && !String(input.note || '').trim()) throw new ValidationError(`${leaveType.name} needs a note`);
    const isHoliday = holidayMatcher(await this._holidays());
    const dates = workingDates({ startDate, endDate, workdays: person.workdays, isHoliday });
    if (dates.length === 0) throw new ValidationError('Those dates have no working days (weekends and holidays are skipped)');
    const size = requestSize({ dates, dayPart, startMinute, endMinute, dailyHours: num(person.dailyHours) || 8 });
    return { leaveType, startDate, endDate, dayPart, startMinute, endMinute, dates, ...size, note: input.note ? String(input.note).slice(0, 2000) : null };
  }

  /** People (e-mails) in the capacity scope for this requester. */
  async _scopeEmails(scope, person, rule) {
    if (scope === 'company') return null; // everyone
    if (scope === 'group') {
      const groupIds = rule.scopeType === 'group' && rule.scopeRef
        ? [Number(rule.scopeRef)]
        : (await prisma.avApprovalGroupMember.findMany({ where: { email: person.email }, select: { groupId: true } })).map((g) => g.groupId);
      if (!groupIds.length) return [];
      const rows = await prisma.avApprovalGroupMember.findMany({ where: { groupId: { in: groupIds } }, select: { email: true } });
      return [...new Set(rows.map((r) => r.email))];
    }
    const officeId = rule.scopeType === 'office' && rule.scopeRef ? Number(rule.scopeRef) : person.officeId;
    if (!officeId) return [];
    const rows = await prisma.avPerson.findMany({ where: { officeId, isActive: true }, select: { email: true } });
    return rows.map((r) => r.email);
  }

  async _capacityWindows(rule, person, shaped, excludeRequestId = null) {
    const c = rule.condition || {};
    const types = Array.isArray(rule.leaveTypeIds) && rule.leaveTypeIds.length ? rule.leaveTypeIds.map(Number) : [shaped.leaveType.id];
    const emails = await this._scopeEmails(c.scope || 'office', person, rule);
    if (Array.isArray(emails) && emails.length === 0) return [];
    const byWeek = c.window !== 'day';
    const from = byWeek ? toDay(weekKey(shaped.startDate)) : shaped.startDate;
    const to = byWeek ? addDays(toDay(weekKey(shaped.endDate)), 6) : shaped.endDate;
    const others = await prisma.avRequest.findMany({
      where: {
        status: { in: ACTIVE },
        leaveTypeId: { in: types },
        startDate: { lte: to },
        endDate: { gte: from },
        email: { not: person.email, ...(emails ? { in: emails } : {}) },
        ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
      },
      select: { email: true, startDate: true, endDate: true },
      take: 5000,
    });
    const windows = new Map();
    const myWindows = [...new Set(shaped.dates.map((d) => (byWeek ? weekKey(d) : d)))];
    for (const w of myWindows) windows.set(w, new Set());
    for (const o of others) {
      for (let d = toDay(o.startDate); d <= toDay(o.endDate); d = addDays(d, 1)) {
        const w = byWeek ? weekKey(d) : dayKey(d);
        if (windows.has(w)) windows.get(w).add(o.email);
      }
    }
    return [...windows.entries()].map(([window, set]) => ({ window, others: set.size }));
  }

  /**
   * The person's own booked days (approved + pending) of the rule's types per
   * day|week window this request touches, and what this request adds there.
   */
  async _ownUsage(rule, person, shaped, excludeRequestId = null) {
    const c = rule.condition || {};
    const types = Array.isArray(rule.leaveTypeIds) && rule.leaveTypeIds.length ? rule.leaveTypeIds.map(Number) : [shaped.leaveType.id];
    if (!types.includes(shaped.leaveType.id)) return [];
    const byWeek = c.window !== 'day';
    const keyOf = (d) => (byWeek ? weekKey(d) : dayKey(d));
    const perDay = shaped.dayPart === 'am' || shaped.dayPart === 'pm' ? 0.5 : shaped.dates.length ? shaped.days / shaped.dates.length : 1;
    const windows = new Map();
    for (const d of shaped.dates) {
      const k = keyOf(d);
      const w = windows.get(k) || { window: k, used: 0, adding: 0 };
      w.adding = Math.round((w.adding + perDay) * 100) / 100;
      windows.set(k, w);
    }
    const from = byWeek ? toDay(weekKey(shaped.startDate)) : shaped.startDate;
    const to = byWeek ? addDays(toDay(weekKey(shaped.endDate)), 6) : shaped.endDate;
    const mine = await prisma.avRequest.findMany({
      where: {
        email: person.email, status: { in: ACTIVE }, leaveTypeId: { in: types }, startDate: { lte: to }, endDate: { gte: from },
        ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
      },
      select: { startDate: true, endDate: true, dayPart: true, days: true },
      take: 500,
    });
    if (mine.length) {
      const isHoliday = holidayMatcher(await this._holidays());
      for (const r of mine) {
        const dates = workingDates({ startDate: r.startDate, endDate: r.endDate, workdays: person.workdays, isHoliday });
        const each = r.dayPart === 'am' || r.dayPart === 'pm' ? 0.5 : dates.length ? num(r.days) / dates.length : 1;
        for (const d of dates) {
          const w = windows.get(keyOf(d));
          if (w) w.used = Math.round((w.used + each) * 100) / 100;
        }
      }
    }
    return [...windows.values()];
  }

  async _decideFor(person, shaped, { excludeRequestId = null, today = new Date() } = {}) {
    const [rules, groups, settings] = await Promise.all([
      prisma.avRule.findMany({ where: { isActive: true } }),
      this._groupsOf(person.email),
      this.getSettings(),
    ]);
    const groupIds = groups.map((g) => g.id);
    const groupAutoApprove = groups.some((g) => {
      const ids = Array.isArray(g.autoApproveTypeIds) ? g.autoApproveTypeIds : [];
      return ids.includes('*') || ids.map(Number).includes(shaped.leaveType.id);
    });
    let remaining = null;
    if (shaped.leaveType.tracksBalance) {
      const year = leaveYearOf(shaped.startDate, settings.yearStartMonth);
      const b = await this._balanceFor(person, shaped.leaveType, year, settings, { excludeRequestId });
      remaining = b.remaining;
    }
    const capacityCache = new Map();
    const usageCache = new Map();
    for (const rule of rules) {
      if (rule.condition?.kind === 'capacity') {
        capacityCache.set(rule.id, await this._capacityWindows(rule, person, shaped, excludeRequestId));
      }
      if (rule.condition?.kind === 'per_person') {
        usageCache.set(rule.id, await this._ownUsage(rule, person, shaped, excludeRequestId));
      }
    }
    const ctx = {
      today: toDay(today), startDate: shaped.startDate, endDate: shaped.endDate, dates: shaped.dates, days: shaped.days,
      person,
      capacity: (rule) => capacityCache.get(rule.id) || [],
      ownUsage: (rule) => usageCache.get(rule.id) || [],
      remaining,
    };
    const verdict = decide({ rules, leaveType: shaped.leaveType, person, groupIds, groupAutoApprove, ctx });
    if (!shaped.leaveType.allowPastDated && toDay(shaped.startDate) < toDay(today) && verdict.outcome !== 'refused') {
      return { ...verdict, outcome: 'pending', reason: 'It starts in the past, so an approver has to confirm it.' };
    }
    return { ...verdict, remaining };
  }

  async preview(user, input) {
    const person = await this.ensurePerson(user);
    const shaped = await this._shape(person, input);
    const verdict = await this._decideFor(person, shaped);
    return {
      outcome: verdict.outcome, reason: verdict.reason, fired: verdict.fired, warnings: verdict.warnings,
      days: shaped.days, hours: shaped.hours, dates: shaped.dates, remaining: verdict.remaining,
    };
  }

  async submit(user, input, { onBehalfOf = null } = {}) {
    let person = await this.ensurePerson(user);
    if (onBehalfOf && lc(onBehalfOf) !== lc(user.email)) {
      await this.assertAdmin(user);
      person = await this.ensurePerson({ email: onBehalfOf });
    }
    const shaped = await this._shape(person, input);
    const overlap = await prisma.avRequest.findFirst({
      where: { email: person.email, status: { in: ACTIVE }, startDate: { lte: shaped.endDate }, endDate: { gte: shaped.startDate }, leaveTypeId: shaped.leaveType.id },
      select: { id: true },
    });
    if (overlap) throw new ValidationError('You already have a request of this type on those dates — change or cancel that one');
    const verdict = await this._decideFor(person, shaped);
    if (verdict.outcome === 'refused') {
      const err = new ValidationError(verdict.reason);
      err.details = { fired: verdict.fired };
      throw err;
    }
    const settings = await this.getSettings();
    const approvers = verdict.outcome === 'pending' ? await this.approversFor(person.email) : [];
    const status = verdict.outcome === 'approved' ? 'approved' : 'pending';
    const now = new Date();
    const request = await prisma.avRequest.create({
      data: {
        email: person.email,
        leaveTypeId: shaped.leaveType.id,
        startDate: shaped.startDate,
        endDate: shaped.endDate,
        dayPart: shaped.dayPart,
        startMinute: shaped.startMinute,
        endMinute: shaped.endMinute,
        days: shaped.days,
        hours: shaped.hours,
        note: shaped.note,
        status,
        decision: { outcome: verdict.outcome, reason: verdict.reason, fired: verdict.fired, approvers },
        decidedBy: status === 'approved' ? 'rules' : null,
        decidedAt: status === 'approved' ? now : null,
        wantsOutlookEvent: Boolean(settings.outlookEventsEnabled && input.wantsOutlookEvent),
        wantsAutoReply: Boolean(settings.autoRepliesEnabled && input.wantsAutoReply),
        createdBy: lc(user.email),
        events: {
          create: [
            { kind: 'created', actor: lc(user.email), details: { days: shaped.days, hours: shaped.hours } },
            { kind: status === 'approved' ? 'auto_approved' : 'sent_for_approval', actor: 'rules', details: { reason: verdict.reason, fired: verdict.fired, approvers } },
          ],
        },
      },
    });
    if (status === 'approved') await this.project(request).catch((err) => logger.warn(`Availability: projection failed for request ${request.id}: ${err.message}`));
    else this._notifyApprovers(request, shaped.leaveType, person, approvers).catch((err) => logger.warn(`Availability: approver notice failed for request ${request.id}: ${err.message}`));
    logger.info(`Availability: request ${request.id} by ${person.email} (${shaped.leaveType.name}, ${shaped.days} day(s)) → ${status}`);
    return this.getRequest(request.id, user);
  }

  async getRequest(id, user) {
    const r = await prisma.avRequest.findUnique({ where: { id: Number(id) }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundError('Request not found');
    const mine = lc(r.email) === lc(user?.email);
    if (!mine && !(await this.canDecide(user, r)) && !(await this.isAdmin(user))) throw new NotFoundError('Request not found');
    return serializeRequest(r);
  }

  async decideRequest(id, action, user, note = null) {
    const r = await prisma.avRequest.findUnique({ where: { id: Number(id) } });
    if (!r) throw new NotFoundError('Request not found');
    if (r.status !== 'pending') throw new ValidationError(`This request is already ${r.status}`);
    if (!(await this.canDecide(user, r))) throw new AuthorizationError('You are not an approver for this person', 'availability_not_approver');
    if (!['approve', 'deny'].includes(action)) throw new ValidationError('Approve or deny');
    if (action === 'deny' && !String(note || '').trim()) throw new ValidationError('Add a short reason when denying');
    const status = action === 'approve' ? 'approved' : 'denied';
    const updated = await prisma.avRequest.update({
      where: { id: r.id },
      data: {
        status,
        decidedBy: lc(user.email),
        decidedAt: new Date(),
        decisionNote: note ? String(note).slice(0, 2000) : null,
        events: { create: { kind: status, actor: lc(user.email), details: note ? { note } : null } },
      },
    });
    if (status === 'approved') await this.project(updated).catch((err) => logger.warn(`Availability: projection failed for request ${r.id}: ${err.message}`));
    this._notifyRequester(updated, user).catch((err) => logger.warn(`Availability: requester notice failed for request ${r.id}: ${err.message}`));
    logger.info(`Availability: request ${r.id} ${status} by ${lc(user.email)}`);
    return this.getRequest(r.id, user);
  }

  async cancelRequest(id, user, reason = null) {
    const r = await prisma.avRequest.findUnique({ where: { id: Number(id) } });
    if (!r) throw new NotFoundError('Request not found');
    const mine = lc(r.email) === lc(user.email);
    if (!mine && !(await this.isAdmin(user)) && !(await this.canDecide(user, r))) throw new AuthorizationError('You can only cancel your own requests', 'availability_not_owner');
    if (!ACTIVE.includes(r.status)) throw new ValidationError(`This request is already ${r.status}`);
    if (r.source === 'vacation_tracker' && await this._vtSyncOnFor(r.email)) {
      throw new ValidationError('This came from Vacation Tracker. Change or cancel it there; Ticket Pulse follows within the hour.');
    }
    const updated = await prisma.avRequest.update({
      where: { id: r.id },
      data: { status: 'cancelled', events: { create: { kind: 'cancelled', actor: lc(user.email), details: reason ? { reason } : null } } },
    });
    await this.unproject(updated).catch((err) => logger.warn(`Availability: unprojection failed for request ${r.id}: ${err.message}`));
    if (!mine) this._notifyRequester(updated, user).catch(() => {});
    return this.getRequest(r.id, user);
  }

  /** Is Vacation Tracker still syncing for a workspace this person works in? */
  async _vtSyncOnFor(email) {
    const techs = await prisma.technician.findMany({ where: { email: { equals: email, mode: 'insensitive' } }, select: { workspaceId: true }, take: 20 });
    const ws = [...new Set(techs.map((t) => t.workspaceId))];
    if (!ws.length) return false;
    const on = await prisma.vacationTrackerConfig.count({ where: { workspaceId: { in: ws }, syncEnabled: true } });
    return on > 0;
  }

  async listMine(user, { year = null } = {}) {
    const person = await this.ensurePerson(user);
    const settings = await this.getSettings();
    const y = year || leaveYearOf(new Date(), settings.yearStartMonth);
    const { start, end } = leaveYearRange(y, settings.yearStartMonth);
    const rows = await prisma.avRequest.findMany({
      where: { email: person.email, startDate: { lte: addDays(end, 366) }, endDate: { gte: start } },
      orderBy: { startDate: 'desc' },
      take: 500,
    });
    return rows.map(serializeRequest);
  }

  async listPendingFor(user) {
    const admin = await this.isAdmin(user);
    const rows = await prisma.avRequest.findMany({ where: { status: 'pending' }, orderBy: { startDate: 'asc' }, take: 500 });
    const out = [];
    for (const r of rows) {
      if (lc(r.email) === lc(user.email)) continue;
      if (admin || (await this.approversFor(r.email)).includes(lc(user.email))) out.push(serializeRequest(r));
    }
    // Approvers see the person's name, not just an e-mail.
    if (out.length) {
      const people = await prisma.avPerson.findMany({ where: { email: { in: [...new Set(out.map((r) => r.email))] } }, select: { email: true, name: true } });
      const nameOf = new Map(people.map((p) => [p.email, p.name]));
      for (const r of out) r.name = nameOf.get(r.email) || null;
    }
    return out;
  }

  // ------------------------------------------------------------------ balances

  async _balanceFor(person, leaveType, year, settings, { excludeRequestId = null } = {}) {
    const { start, end } = leaveYearRange(year, settings.yearStartMonth);
    // A per-person allowance (e.g. 3-5 weeks of vacation by seniority) replaces
    // the type's annual days and tenure tiers; pro-rating still applies.
    const own = person.entitlementOverrides && typeof person.entitlementOverrides === 'object'
      ? person.entitlementOverrides[String(leaveType.id)] : undefined;
    const policy = own !== undefined && own !== null && own !== '' && Number.isFinite(Number(own))
      ? { ...(leaveType.balancePolicy || {}), annualDays: Number(own), tenureTiers: [] }
      : leaveType.balancePolicy;
    const entitled = entitlementFor(policy, { startDate: person.startDate, year, yearStartMonth: settings.yearStartMonth });
    const [adj, reqs] = await Promise.all([
      prisma.avBalanceAdjustment.findMany({ where: { email: person.email, leaveTypeId: leaveType.id, year }, select: { days: true, kind: true } }),
      prisma.avRequest.findMany({
        where: { email: person.email, leaveTypeId: leaveType.id, status: { in: ACTIVE }, startDate: { gte: start, lte: end }, ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}) },
        select: { days: true, status: true, endDate: true },
      }),
    ]);
    const adjustments = adj.reduce((s, a) => s + num(a.days), 0);
    const today = toDay(new Date());
    let taken = 0;
    let scheduled = 0;
    let pending = 0;
    for (const r of reqs) {
      if (r.status === 'pending') pending += num(r.days);
      else if (toDay(r.endDate) < today) taken += num(r.days);
      else scheduled += num(r.days);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      leaveTypeId: leaveType.id, name: leaveType.name, year,
      entitled: r2(entitled), adjustments: r2(adjustments), taken: r2(taken), scheduled: r2(scheduled), pending: r2(pending),
      remaining: r2(entitled + adjustments - taken - scheduled - pending),
    };
  }

  async balances(email, { year = null } = {}) {
    const person = await prisma.avPerson.findUnique({ where: { email: lc(email) } });
    if (!person) return [];
    const settings = await this.getSettings();
    const y = year || leaveYearOf(new Date(), settings.yearStartMonth);
    const types = await prisma.avLeaveType.findMany({ where: { isActive: true, tracksBalance: true }, orderBy: { sortOrder: 'asc' } });
    const out = [];
    for (const t of types) out.push(await this._balanceFor(person, t, y, settings));
    return out;
  }

  async balanceReport(user, { year = null } = {}) {
    await this.assertAdmin(user);
    const people = await this.listPeople();
    const out = [];
    for (const p of people) out.push({ email: p.email, name: p.name, balances: await this.balances(p.email, { year }) });
    return out;
  }

  async adjustBalance(input, actor) {
    await this.assertAdmin(actor);
    const days = Number(input.days);
    if (!Number.isFinite(days) || days === 0) throw new ValidationError('Enter the number of days to add (or subtract)');
    if (!String(input.note || '').trim()) throw new ValidationError('Add a reason for the adjustment');
    const kind = ['adjustment', 'carryover', 'import'].includes(input.kind) ? input.kind : 'adjustment';
    return prisma.avBalanceAdjustment.create({
      data: { email: lc(input.email), leaveTypeId: Number(input.leaveTypeId), year: Number(input.year), kind, days, note: String(input.note).slice(0, 1000), actor: lc(actor.email) },
    });
  }

  // ------------------------------------------------------------------ calendar

  /** Team calendar: people + their approved/pending entries in [from, to], redacted by visibility. */
  async calendar(user, { from, to, officeId = null, groupId = null }) {
    const start = toDay(from);
    const end = toDay(to);
    if (!start || !end || end < start) throw new ValidationError('Pick a date range');
    if (daysSpan(start, end) > 93) throw new ValidationError('Show at most three months at a time');
    const admin = await this.isAdmin(user);
    let people = await prisma.avPerson.findMany({ where: { isActive: true, ...(officeId ? { officeId: Number(officeId) } : {}) }, orderBy: { name: 'asc' }, select: { email: true, name: true, officeId: true }, take: 2000 });
    if (groupId) {
      const members = new Set((await prisma.avApprovalGroupMember.findMany({ where: { groupId: Number(groupId) }, select: { email: true } })).map((m) => m.email));
      people = people.filter((p) => members.has(p.email));
    }
    const emails = people.map((p) => p.email);
    const [rows, types] = await Promise.all([
      prisma.avRequest.findMany({
        where: { email: { in: emails }, status: { in: ACTIVE }, startDate: { lte: end }, endDate: { gte: start } },
        select: { id: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, status: true, days: true },
        take: 10000,
      }),
      prisma.avLeaveType.findMany(),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const approverOf = new Set();
    for (const r of rows) {
      if (!admin && lc(r.email) !== lc(user.email) && !approverOf.has(r.email) && (await this.approversFor(r.email)).includes(lc(user.email))) approverOf.add(r.email);
    }
    const entries = [];
    for (const r of rows) {
      const t = typeById.get(r.leaveTypeId);
      const privileged = admin || lc(r.email) === lc(user.email) || approverOf.has(r.email);
      if (!t) continue;
      if (t.visibility === 'private' && !privileged) continue;
      const redact = t.visibility === 'away' && !privileged;
      entries.push({
        id: privileged ? r.id : null,
        email: r.email,
        startDate: dayKey(r.startDate),
        endDate: dayKey(r.endDate),
        dayPart: r.dayPart,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
        status: r.status,
        leaveTypeId: redact ? null : t.id,
        label: redact ? 'Away' : t.name,
        color: redact ? 'slate' : t.color,
        availability: t.availability,
      });
    }
    const isHoliday = holidayMatcher(await this._holidays());
    const holidays = [];
    for (let d = start; d <= end; d = addDays(d, 1)) if (isHoliday(d)) holidays.push(dayKey(d));
    return { from: dayKey(start), to: dayKey(end), people, entries, holidays };
  }

  /** Who is out today (OFF / WFH / ONSITE) — for the dashboard strip and Teams digest. */
  async outToday(user, { date = new Date() } = {}) {
    const d = dayKey(date);
    const cal = await this.calendar(user, { from: d, to: d });
    return cal.entries;
  }

  // ------------------------------------------------------------------ projection into technician_leaves

  async _projectionTargets(request) {
    const techs = await prisma.technician.findMany({ where: { email: { equals: request.email, mode: 'insensitive' } }, select: { id: true, workspaceId: true }, take: 20 });
    if (request.source !== 'vacation_tracker') return techs;
    const vt = await prisma.vacationTrackerConfig.findMany({ where: { syncEnabled: true }, select: { workspaceId: true } });
    const synced = new Set(vt.map((v) => v.workspaceId));
    return techs.filter((t) => !synced.has(t.workspaceId));
  }

  async project(request) {
    if (request.status !== 'approved') return { written: 0 };
    const type = await prisma.avLeaveType.findUnique({ where: { id: request.leaveTypeId } });
    const category = AVAILABILITY_TO_CATEGORY[type?.availability];
    if (!category) return { written: 0 }; // NONE: doesn't affect availability
    const person = await prisma.avPerson.findUnique({ where: { email: request.email } });
    const isHoliday = holidayMatcher(await this._holidays());
    const dates = workingDates({ startDate: request.startDate, endDate: request.endDate, workdays: person?.workdays, isHoliday });
    const targets = await this._projectionTargets(request);
    const half = request.dayPart === 'am' ? 'AM' : request.dayPart === 'pm' ? 'PM' : null;
    const partial = request.dayPart !== 'full';
    let written = 0;
    for (const t of targets) {
      const key = `av:${request.id}:w${t.workspaceId}`;
      await prisma.technicianLeave.deleteMany({ where: { vtLeaveId: key } });
      for (const date of dates) {
        await prisma.technicianLeave.create({
          data: {
            workspaceId: t.workspaceId,
            technicianId: t.id,
            vtLeaveId: key,
            leaveDate: toDay(date),
            leaveTypeName: type.name,
            category,
            status: 'APPROVED',
            isFullDay: !partial,
            halfDayPart: half || (request.dayPart === 'hours' ? (((request.startMinute + request.endMinute) / 2) < 720 ? 'AM' : 'PM') : null),
            startMinute: request.dayPart === 'hours' ? request.startMinute : (half === 'AM' ? 0 : half === 'PM' ? 720 : null),
            endMinute: request.dayPart === 'hours' ? request.endMinute : (half === 'AM' ? 720 : half === 'PM' ? 1440 : null),
          },
        });
        written += 1;
      }
    }
    return { written };
  }

  async unproject(request) {
    const res = await prisma.technicianLeave.deleteMany({ where: { vtLeaveId: { startsWith: `av:${request.id}:` } } });
    return { deleted: res.count };
  }

  /** Re-write every approved request's projection (after cut-over from Vacation Tracker). */
  async reprojectAll(actor, { from = null } = {}) {
    await this.assertAdmin(actor);
    const since = from ? toDay(from) : addDays(toDay(new Date()), -30);
    const rows = await prisma.avRequest.findMany({ where: { status: 'approved', endDate: { gte: since } }, take: 20000 });
    let written = 0;
    for (const r of rows) {
      await this.unproject(r);
      written += (await this.project(r)).written;
    }
    return { requests: rows.length, written };
  }

  // ------------------------------------------------------------------ notifications

  async _baseUrl() {
    const { resolvePublicBaseUrl } = await import('../../utils/publicBaseUrl.js');
    return resolvePublicBaseUrl({ fallback: 'https://ticketpulse.bgcsaas.com' });
  }

  async _notifyApprovers(request, leaveType, person, approvers) {
    if (!approvers.length) return;
    const { sendEmail } = await import('../sendgridNotificationService.js');
    const base = await this._baseUrl();
    const range = describeRange(request);
    const html = emailHtml({
      title: `${person.name} asked for ${leaveType.name.toLowerCase()}`,
      lines: [range, request.note ? `Note: ${request.note}` : null, request.decision?.reason ? `Why it needs you: ${request.decision.reason}` : null],
      button: { label: 'Review in Ticket Pulse', url: `${base}/availability/approvals` },
    });
    await sendEmail({ to: approvers, subject: `Availability: ${person.name} — ${leaveType.name}, ${range}`, html, context: 'availability' });
  }

  async _notifyRequester(request, actor) {
    const { sendEmail } = await import('../sendgridNotificationService.js');
    const type = await prisma.avLeaveType.findUnique({ where: { id: request.leaveTypeId } });
    const base = await this._baseUrl();
    const verb = request.status === 'approved' ? 'approved' : request.status === 'denied' ? 'denied' : 'cancelled';
    const html = emailHtml({
      title: `Your ${type?.name?.toLowerCase() || 'request'} was ${verb}`,
      lines: [describeRange(request), `By ${actor?.name || actor?.email || 'an approver'}`, request.decisionNote ? `Note: ${request.decisionNote}` : null],
      button: { label: 'Open Availability', url: `${base}/availability` },
    });
    await sendEmail({ to: [request.email], subject: `Availability: ${type?.name || 'Request'} ${verb} — ${describeRange(request)}`, html, context: 'availability' });
  }

  // ------------------------------------------------------------------ Vacation Tracker import

  /**
   * Import approved leaves from Vacation Tracker (read-only v1 API) as
   * approved requests. Idempotent on externalId 'vt:<leaveId>'. Unmapped VT
   * leave types are created as new (inactive-for-requests) types so nothing
   * is lost; people are matched by e-mail.
   */
  async importFromVacationTracker(actor, { workspaceId, from, to }, { client = null } = {}) {
    await this.assertAdmin(actor);
    return this.syncFromVacationTracker(Number(workspaceId), { from, to, client, actorEmail: lc(actor.email) });
  }

  /**
   * One-way Vacation Tracker -> Availability sync (Vahid, 3 Oct 2026: people
   * may keep using VT until Availability is ready; like FreshService, either
   * works). Runs after every hourly VT sync for workspaces with VT on, and
   * from Settings -> Import. Idempotent on externalId 'vt:<leaveId>':
   *   - new approved VT leave       -> approved request (source vacation_tracker)
   *   - changed dates / type / part -> request updated, projection rebuilt
   *   - no longer approved, or gone from VT within the window -> cancelled
   * Unknown VT leave types become new types so nothing is lost; people are
   * matched by e-mail.
   */
  async syncFromVacationTracker(workspaceId, { from = null, to = null, client = null, actorEmail = 'vacation_tracker' } = {}) {
    if (!client) {
      const config = await prisma.vacationTrackerConfig.findUnique({ where: { workspaceId: Number(workspaceId) } });
      if (!config?.apiKey) throw new ValidationError('Vacation Tracker is not set up for that workspace');
      const { default: VacationTrackerClient } = await import('../../integrations/vacationTracker.js');
      client = new VacationTrackerClient(config.apiKey);
    }
    await this.ensureSeed();
    const start = dayKey(from ? toDay(from) : addDays(toDay(new Date()), -60));
    const end = dayKey(to ? toDay(to) : addDays(toDay(new Date()), 365));
    const [vtTypes, vtUsers, vtLeaves] = await Promise.all([client.fetchLeaveTypes(), client.fetchUsers(), client.fetchLeaves(start, end)]);
    const types = await prisma.avLeaveType.findMany();
    const typeForVt = new Map();
    for (const vt of vtTypes || []) {
      const name = lc(vt.name);
      let match = types.find((t) => (Array.isArray(t.vtLeaveTypeNames) ? t.vtLeaveTypeNames.map(lc) : []).includes(name))
        || types.find((t) => lc(t.name) === name)
        || types.find((t) => (Array.isArray(t.vtLeaveTypeNames) ? t.vtLeaveTypeNames.map(lc) : []).some((n) => name.includes(n)));
      if (!match) {
        const key = `vt_${name.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`.slice(0, 40);
        match = await prisma.avLeaveType.upsert({
          where: { key },
          update: {},
          create: { key, name: vt.name, availability: guessAvailability(name), requiresApproval: true, sortOrder: 200, vtLeaveTypeNames: [name] },
        });
        types.push(match);
      }
      typeForVt.set(vt.id, match);
    }
    const emailForVtUser = new Map((vtUsers || []).map((u) => [u.id, lc(u.email)]));
    const nameForVtUser = new Map((vtUsers || []).map((u) => [u.id, u.name || null]));
    await this.syncPeople();
    const people = new Map((await prisma.avPerson.findMany({ select: { email: true, workdays: true, dailyHours: true } })).map((p) => [p.email, p]));
    const isHoliday = holidayMatcher(await this._holidays());
    const existing = new Map((await prisma.avRequest.findMany({
      where: { source: 'vacation_tracker', externalId: { not: null } },
      select: { id: true, externalId: true, email: true, leaveTypeId: true, startDate: true, endDate: true, dayPart: true, startMinute: true, endMinute: true, status: true },
      take: 50000,
    })).map((r) => [r.externalId, r]));

    let created = 0;
    let updated = 0;
    let cancelled = 0;
    let skipped = 0;
    let unmatched = 0;
    const seen = new Set();
    for (const leave of vtLeaves || []) {
      const externalId = `vt:${leave.id}`;
      const approved = !leave.status || String(leave.status).toUpperCase() === 'APPROVED';
      const mine = existing.get(externalId);
      seen.add(externalId); // handled here; never cancelled again below as "gone"
      if (!approved) {
        if (mine && ACTIVE.includes(mine.status)) {
          await this._cancelSynced(mine, `Vacation Tracker status ${leave.status}`, actorEmail);
          cancelled += 1;
        } else skipped += 1;
        continue;
      }
      const email = emailForVtUser.get(leave.userId);
      const type = typeForVt.get(leave.leaveTypeId);
      if (!email || !type) { unmatched += 1; continue; }
      if (!people.has(email)) {
        const p = await prisma.avPerson.create({ data: { email, name: nameForVtUser.get(leave.userId) || email.split('@')[0] } }).catch(() => null);
        if (p) people.set(email, p);
      }
      const person = people.get(email) || {};
      const partial = leave.isFullDayLeave === false;
      const startMinute = partial ? (leave.startHour ?? 0) * 60 + (leave.startMinute ?? 0) : null;
      const endMinute = partial ? (leave.endHour ?? 0) * 60 + (leave.endMinute ?? 0) : null;
      // 3 h or more is a half day (VT sync reads every partial as AM/PM); shorter stays hours.
      const dayPart = partial ? (endMinute - startMinute >= 180 ? (((startMinute + endMinute) / 2) < 720 ? 'am' : 'pm') : 'hours') : 'full';
      const dates = workingDates({ startDate: leave.startDate, endDate: leave.endDate, workdays: person.workdays, isHoliday });
      const size = requestSize({ dates, dayPart, startMinute, endMinute, dailyHours: num(person.dailyHours) || 8 });
      const fields = {
        email, leaveTypeId: type.id, startDate: toDay(leave.startDate), endDate: toDay(leave.endDate), dayPart,
        startMinute: dayPart === 'hours' ? startMinute : null, endMinute: dayPart === 'hours' ? endMinute : null,
        days: size.days, hours: size.hours,
      };
      if (mine) {
        const same = mine.leaveTypeId === fields.leaveTypeId && dayKey(mine.startDate) === dayKey(fields.startDate)
          && dayKey(mine.endDate) === dayKey(fields.endDate) && mine.dayPart === fields.dayPart
          && (mine.startMinute ?? null) === (fields.startMinute ?? null) && (mine.endMinute ?? null) === (fields.endMinute ?? null)
          && mine.status === 'approved';
        if (same) { skipped += 1; continue; }
        const row = await prisma.avRequest.update({
          where: { id: mine.id },
          data: {
            ...fields, status: 'approved',
            events: { create: { kind: 'synced_update', actor: actorEmail, details: { vtLeaveId: leave.id, from: { start: dayKey(mine.startDate), end: dayKey(mine.endDate), status: mine.status } } } },
          },
        });
        await this.unproject(row).catch(() => null);
        await this.project(row).catch(() => null);
        updated += 1;
        continue;
      }
      const request = await prisma.avRequest.create({
        data: {
          ...fields, note: leave.reason ? String(leave.reason).slice(0, 2000) : null,
          status: 'approved', decidedBy: 'vacation_tracker', decidedAt: new Date(), source: 'vacation_tracker', externalId,
          decision: { outcome: 'approved', reason: 'Approved in Vacation Tracker', fired: [] },
          createdBy: actorEmail,
          events: { create: { kind: 'imported', actor: actorEmail, details: { vtLeaveId: leave.id, vtLeaveType: type.name } } },
        },
      });
      await this.project(request).catch(() => null);
      created += 1;
    }

    // Gone from VT: an active synced request starting inside the window that
    // VT no longer returns was deleted there. Guard against an empty or
    // failed listing wiping everything.
    const windowStart = toDay(start);
    const windowEnd = toDay(end);
    const candidates = [...existing.values()].filter((r) => ACTIVE.includes(r.status) && !seen.has(r.externalId)
      && toDay(r.startDate) >= windowStart && toDay(r.startDate) <= windowEnd);
    const listedApproved = (vtLeaves || []).filter((l) => !l.status || String(l.status).toUpperCase() === 'APPROVED').length;
    if (candidates.length && listedApproved === 0) {
      logger.warn(`Availability: VT sync ws ${workspaceId} listed no approved leaves; not cancelling ${candidates.length} synced request(s)`);
    } else {
      for (const r of candidates) {
        await this._cancelSynced(r, 'No longer in Vacation Tracker', actorEmail);
        cancelled += 1;
      }
    }
    const summary = { created, updated, cancelled, skipped, unmatched, from: start, to: end };
    if (created || updated || cancelled) logger.info(`Availability: Vacation Tracker sync ws ${workspaceId} (${start}..${end})`, summary);
    return summary;
  }

  async _cancelSynced(request, reason, actorEmail) {
    const row = await prisma.avRequest.update({
      where: { id: request.id },
      data: { status: 'cancelled', events: { create: { kind: 'cancelled', actor: actorEmail, details: { reason, source: 'vacation_tracker' } } } },
    });
    await this.unproject(row).catch(() => null);
  }

  /**
   * Opening balances from Vacation Tracker's Leave Balance Report (CSV/Excel
   * pasted as CSV). Columns (case-insensitive): email, leave type,
   * remaining OR (entitlement + taken + brought forward). Writes one 'import'
   * adjustment per row so remaining matches VT for the year.
   */
  async importBalancesCsv(actor, { csv, year }) {
    await this.assertAdmin(actor);
    const rows = parseCsv(String(csv || ''));
    if (rows.length < 2) throw new ValidationError('Paste the CSV including its header row');
    const header = rows[0].map(lc);
    const col = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const iEmail = col('email');
    const iType = col('leave type', 'leavetype', 'type');
    const iRemaining = col('remaining', 'available');
    if (iEmail < 0 || iType < 0 || iRemaining < 0) throw new ValidationError('The CSV needs Email, Leave type and Remaining columns');
    const settings = await this.getSettings();
    const y = Number(year) || leaveYearOf(new Date(), settings.yearStartMonth);
    const types = await prisma.avLeaveType.findMany({ where: { tracksBalance: true } });
    let written = 0;
    const problems = [];
    for (const r of rows.slice(1)) {
      const email = lc(r[iEmail]);
      const typeName = lc(r[iType]);
      const target = Number(String(r[iRemaining] || '').replace(/[^0-9.-]/g, ''));
      if (!email || !typeName || !Number.isFinite(target)) continue;
      const type = types.find((t) => lc(t.name) === typeName || (Array.isArray(t.vtLeaveTypeNames) && t.vtLeaveTypeNames.map(lc).includes(typeName)));
      if (!type) { problems.push(`${email}: no balance-tracked type matches "${r[iType]}"`); continue; }
      const person = await prisma.avPerson.findUnique({ where: { email } });
      if (!person) { problems.push(`${email}: not a Ticket Pulse user`); continue; }
      const current = await this._balanceFor(person, type, y, settings);
      const delta = Math.round((target - current.remaining) * 100) / 100;
      if (delta === 0) continue;
      await prisma.avBalanceAdjustment.create({ data: { email, leaveTypeId: type.id, year: y, kind: 'import', days: delta, note: 'Opening balance from Vacation Tracker', actor: lc(actor.email) } });
      written += 1;
    }
    return { written, problems: problems.slice(0, 50), year: y };
  }
}

function daysSpan(a, b) {
  return Math.round((toDay(b).getTime() - toDay(a).getTime()) / 86400000);
}

function guessProvince(name) {
  const n = lc(name);
  if (/vancouver|victoria|kamloops|kelowna|burnaby|nanaimo|prince george|bc\b/.test(n)) return 'BC';
  if (/calgary|edmonton|alberta|ab\b/.test(n)) return 'AB';
  if (/toronto|ottawa|ontario|on\b/.test(n)) return 'ON';
  if (/montr|qu[eé]bec/.test(n)) return 'QC';
  if (/yellowknife/.test(n)) return 'NT';
  if (/whitehorse/.test(n)) return 'YT';
  return null;
}

function guessAvailability(name) {
  if (/home|remote|wfh/.test(name)) return 'WFH';
  if (/site|field|travel|trip/.test(name)) return 'ONSITE';
  return 'OFF';
}

export function serializeRequest(r) {
  return {
    id: r.id,
    email: r.email,
    leaveTypeId: r.leaveTypeId,
    startDate: dayKey(r.startDate),
    endDate: dayKey(r.endDate),
    dayPart: r.dayPart,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    days: num(r.days),
    hours: num(r.hours),
    note: r.note,
    status: r.status,
    decision: r.decision || null,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    source: r.source,
    wantsOutlookEvent: r.wantsOutlookEvent,
    wantsAutoReply: r.wantsAutoReply,
    createdAt: r.createdAt,
    events: r.events ? r.events.map((e) => ({ kind: e.kind, actor: e.actor, details: e.details, createdAt: e.createdAt })) : undefined,
  };
}

export function describeRange(r) {
  const s = dayKey(r.startDate);
  const e = dayKey(r.endDate);
  const fmt = (k) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const part = r.dayPart === 'am' ? ' (morning)' : r.dayPart === 'pm' ? ' (afternoon)' : r.dayPart === 'hours' && (r.startMinute !== null && r.startMinute !== undefined)
    ? ` (${hhmm(r.startMinute)}–${hhmm(r.endMinute)})` : '';
  return s === e ? `${fmt(s)}${part}` : `${fmt(s)} – ${fmt(e)}${part}`;
}

function hhmm(m) {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${h}:${mm}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Outlook-safe: no gradients, explicit colours, bgcolor on cells.
function emailHtml({ title, lines = [], button = null }) {
  const body = lines.filter(Boolean).map((l) => `<p style="margin:0 0 8px;color:#334155;font-size:14px;line-height:1.5">${escapeHtml(l)}</p>`).join('');
  const btn = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr><td bgcolor="#2563eb" style="background-color:#2563eb;border-radius:8px"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:10px 16px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none">${escapeHtml(button.label)}</a></td></tr></table>`
    : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 12px;color:#0f172a;font-size:18px">${escapeHtml(title)}</h2>${body}${btn}<p style="margin:16px 0 0;color:#64748b;font-size:12px">Ticket Pulse · Availability</p></div>`;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { row.push(cell.trim()); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const availabilityService = new AvailabilityService();
export default availabilityService;
