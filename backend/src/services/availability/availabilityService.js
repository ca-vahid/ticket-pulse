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
import settingsRepository from '../settingsRepository.js';
import vtWriteBack, { isVtExternalId } from './vtWriteBack.js';
import availabilityTeams from './availabilityTeams.js';
import { currentViewAs } from '../viewAsContext.js';
import { ValidationError, NotFoundError, AuthorizationError } from '../../utils/errors.js';
import {
  decide, workingDates, requestSize, holidayMatcher, toDay, dayKey, addDays, weekKey,
  leaveYearOf, leaveYearRange, entitlementFor, RULE_KINDS, RULE_OUTCOMES,
} from './availabilityRules.js';

const lc = (s) => String(s || '').trim().toLowerCase();
const num = (d) => ((d === null || d === undefined) ? 0 : Number(d));
const ACTIVE = ['approved', 'pending'];
const SERVICE_ACCOUNT_RE = /^ticket ?pulse$|\bdomain admin\b|^adm[_-]/i;
// "View as a role" (a super admin trying a workspace role on): the person keeps
// their e-mail, so every check here has to answer from the role being tried.
const roleView = (user) => {
  const v = currentViewAs() || user?.viewAs || null;
  return v?.mode === 'role' ? v : null;
};
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
    if ((patch.vtWriteBackEnabled !== null && patch.vtWriteBackEnabled !== undefined)) data.vtWriteBackEnabled = Boolean(patch.vtWriteBackEnabled);
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
    const view = roleView(user);
    if (view) return view.role === 'admin';
    if (user.role === 'admin') return true;
    const row = await prisma.workspaceAccess.findFirst({ where: { email: lc(user.email), role: 'admin' }, select: { id: true } });
    return Boolean(row);
  }

  /**
   * Super admins: the global list sign-in uses (the admin_emails setting, else
   * ADMIN_EMAILS). Workspace admins are not on it.
   */
  async superAdminEmails() {
    let raw = null;
    try { raw = await settingsRepository.get('admin_emails'); } catch { /* fall through */ }
    if (!raw || !String(raw).trim()) raw = process.env.ADMIN_EMAILS || '';
    return [...new Set(String(raw).split(',').map(lc).filter(Boolean))];
  }

  async isSuperAdmin(user) {
    if (!user?.email) return false;
    if (roleView(user)) return false;
    return (await this.superAdminEmails()).includes(lc(user.email));
  }

  /** Workspaces this person administers: null = every one (super admin), else their ids. */
  async _adminWorkspaceIds(user) {
    if (!user?.email) return [];
    const view = roleView(user);
    if (view) return view.role === 'admin' ? [Number(view.workspaceId)] : [];
    if (user.role === 'admin' || await this.isSuperAdmin(user)) return null;
    const rows = await prisma.workspaceAccess.findMany({ where: { email: lc(user.email), role: 'admin' }, select: { workspaceId: true }, take: 50 });
    return rows.map((r) => r.workspaceId).filter((id) => Number.isInteger(id));
  }

  /** Sees waiting and private entries of this workspace's people: its admins and the super admins. */
  async _privilegedIn(user, workspaceId) {
    const ids = await this._adminWorkspaceIds(user);
    return ids === null || ids.includes(Number(workspaceId));
  }

  /**
   * May this person open, cancel, book for or adjust `email`? Super admins for
   * anyone; a workspace admin only for the people of a workspace they
   * administer (QA 10-13 #8: it used to be any admin of any workspace).
   */
  async canManagePerson(user, email) {
    const ids = await this._adminWorkspaceIds(user);
    if (ids === null) return true;
    if (!ids.length || !lc(email)) return false;
    const [tech, access] = await Promise.all([
      prisma.technician.findFirst({ where: { workspaceId: { in: ids }, email: { equals: lc(email), mode: 'insensitive' } }, select: { id: true } }),
      prisma.workspaceAccess.findFirst({ where: { workspaceId: { in: ids }, email: lc(email) }, select: { id: true } }),
    ]);
    return Boolean(tech || access);
  }

  /**
   * Who the team calendar shows (5 Oct 2026, Vahid): the active agents of the
   * workspace the viewer is in, never the whole company. "Other teams" people
   * kept as assignable-only (isActive false) are not part of the team. The
   * viewer must belong to that workspace (admin, member, or active agent);
   * otherwise, or with no workspace, the workspaces they are an active agent
   * in. The viewer is always included. Returns a Set of e-mails.
   */
  async rosterFor(user, workspaceId = null) {
    const email = lc(user?.email);
    const ws = Number(workspaceId);
    let workspaceIds = [];
    // QA 10-13 #7: a super admin viewing as a role in another workspace was
    // looked up as themselves, not found there, and shown their own team (IT)
    // under that workspace's name. The view decides which workspace they are in.
    const view = roleView(user);
    if (Number.isInteger(ws) && ws > 0) {
      let allowed = view ? Number(view.workspaceId) === ws : user?.role === 'admin';
      if (!allowed && !view) {
        const [access, tech] = await Promise.all([
          prisma.workspaceAccess.findFirst({ where: { workspaceId: ws, email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
          prisma.technician.findFirst({ where: { workspaceId: ws, isActive: true, email: { equals: email, mode: 'insensitive' } }, select: { id: true } }),
        ]);
        allowed = Boolean(access || tech);
      }
      if (allowed) workspaceIds = [ws];
    }
    if (!workspaceIds.length && !view) {
      const mine = await prisma.technician.findMany({ where: { isActive: true, email: { equals: email, mode: 'insensitive' } }, select: { workspaceId: true }, take: 20 });
      workspaceIds = [...new Set(mine.map((t) => t.workspaceId))];
    }
    const techs = workspaceIds.length
      ? await prisma.technician.findMany({ where: { workspaceId: { in: workspaceIds }, isActive: true, email: { not: null } }, select: { email: true, name: true }, take: 2000 })
      : [];
    // Service accounts are agents in FreshService but not people who take time
    // off (the "Ticket Pulse" automation agent, admin twins of real people).
    const roster = new Set(techs.filter((t) => !SERVICE_ACCOUNT_RE.test(String(t.name || ''))).map((t) => lc(t.email)).filter(Boolean));
    if (email) roster.add(email);
    return roster;
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
      // Nobody set up yet: fall back to the super admins so nothing is stuck.
      // (13 Oct 2026: this used to be every admin of every workspace, and a
      // vacation request reached eleven people.)
      for (const a of await this.superAdminEmails()) if (a !== lc(email)) out.add(a);
    }
    if (out.size === 0) {
      // Last resort (no super admin other than the person asking): workspace admins.
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
    // Super admins can always step in; a workspace admin decides only when
    // named as an approver.
    if (await this.isSuperAdmin(user)) return true;
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
    const target = await prisma.avPerson.findUnique({ where: { id: Number(id) }, select: { email: true } });
    if (!target) throw new NotFoundError('Person not found');
    if (!(await this.canManagePerson(actor, target.email))) throw new AuthorizationError('You can change people in the workspaces you administer', 'availability_not_your_team');
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
    return prisma.holiday.findMany({ where: { workspaceId: null, isEnabled: true }, select: { date: true, name: true, isRecurring: true, isEnabled: true }, take: 2000 });
  }

  /** { 'YYYY-MM-DD': name } for the holidays in [start, end] (recurring ones by month-day). */
  async _holidayNames(start, end) {
    const rows = await this._holidays();
    const exact = new Map();
    const recurring = new Map();
    for (const h of rows) {
      const k = dayKey(h.date);
      if (h.isRecurring) recurring.set(k.slice(5), h.name || 'Holiday');
      else exact.set(k, h.name || 'Holiday');
    }
    const out = {};
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const k = dayKey(d);
      const name = exact.get(k) || recurring.get(k.slice(5));
      if (name) out[k] = name;
    }
    return out;
  }

  /** The next `limit` holidays from today (within a year), for the Overview. */
  async upcomingHolidays({ from = new Date(), limit = 4 } = {}) {
    const start = toDay(dayKey(from));
    const names = await this._holidayNames(start, addDays(start, 365));
    return Object.entries(names).slice(0, Math.max(1, Math.min(10, Number(limit) || 4))).map(([date, name]) => ({ date, name }));
  }

  /**
   * The people the team views show (5 Oct 2026): the workspace roster
   * (rosterFor) with their office, approval groups and directory photo.
   * Photos come once per page here, never per calendar entry. Groups are
   * only the approval groups that have someone on this roster.
   */
  async roster(user, workspaceId = null) {
    const emails = [...(await this.rosterFor(user, workspaceId))];
    const ws = Number(workspaceId);
    const [people, techs, members, groups, offices] = await Promise.all([
      prisma.avPerson.findMany({ where: { isActive: true, email: { in: emails } }, orderBy: { name: 'asc' }, select: { email: true, name: true, officeId: true }, take: 2000 }),
      prisma.technician.findMany({
        where: { isActive: true, email: { in: emails, mode: 'insensitive' }, ...(Number.isInteger(ws) && ws > 0 ? { workspaceId: ws } : {}) },
        select: { email: true, name: true, photoUrl: true },
        take: 2000,
      }),
      prisma.avApprovalGroupMember.findMany({ where: { email: { in: emails } }, select: { email: true, groupId: true }, take: 5000 }),
      prisma.avApprovalGroup.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.avOffice.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    const techByEmail = new Map();
    for (const t of techs) if (t.email && !techByEmail.has(lc(t.email))) techByEmail.set(lc(t.email), t);
    const groupIdsByEmail = new Map();
    for (const m of members) {
      if (!groupIdsByEmail.has(m.email)) groupIdsByEmail.set(m.email, []);
      groupIdsByEmail.get(m.email).push(m.groupId);
    }
    const usedGroups = new Set(members.map((m) => m.groupId));
    return {
      people: people.map((p) => {
        const t = techByEmail.get(lc(p.email));
        return { email: p.email, name: t?.name || p.name, officeId: p.officeId, photoUrl: t?.photoUrl || null, groupIds: groupIdsByEmail.get(p.email) || [] };
      }),
      groups: groups.filter((g) => usedGroups.has(g.id)),
      offices,
    };
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
      if (!(await this.canManagePerson(user, onBehalfOf))) throw new AuthorizationError('You can book for people in the workspaces you administer', 'availability_not_your_team');
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
    if (status === 'approved') {
      await this.project(request).catch((err) => logger.warn(`Availability: projection failed for request ${request.id}: ${err.message}`));
      vtWriteBack.pushApproved(request.id); // never throws; not awaited so booking stays quick
    } else this._notifyApprovers(request, shaped.leaveType, person, approvers).catch((err) => logger.warn(`Availability: approver notice failed for request ${request.id}: ${err.message}`));
    this._teamsSubmitted(request, shaped.leaveType, person, user, approvers).catch(() => {});
    logger.info(`Availability: request ${request.id} by ${person.email} (${shaped.leaveType.name}, ${shaped.days} day(s)) → ${status}`);
    return this.getRequest(request.id, user);
  }

  async getRequest(id, user) {
    const r = await prisma.avRequest.findUnique({ where: { id: Number(id) }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundError('Request not found');
    const mine = lc(r.email) === lc(user?.email);
    if (!mine && !(await this.canDecide(user, r)) && !(await this.canManagePerson(user, r.email))) throw new NotFoundError('Request not found');
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
    if (status === 'approved') {
      await this.project(updated).catch((err) => logger.warn(`Availability: projection failed for request ${r.id}: ${err.message}`));
      vtWriteBack.pushApproved(updated.id); // never throws
    }
    this._notifyRequester(updated, user).catch((err) => logger.warn(`Availability: requester notice failed for request ${r.id}: ${err.message}`));
    this._teamsDecided(updated, user).catch(() => {});
    logger.info(`Availability: request ${r.id} ${status} by ${lc(user.email)}`);
    return this.getRequest(r.id, user);
  }

  async cancelRequest(id, user, reason = null) {
    const r = await prisma.avRequest.findUnique({ where: { id: Number(id) } });
    if (!r) throw new NotFoundError('Request not found');
    const mine = lc(r.email) === lc(user.email);
    if (!mine && !(await this.canDecide(user, r)) && !(await this.canManagePerson(user, r.email))) throw new AuthorizationError('You can only cancel your own requests', 'availability_not_owner');
    if (!ACTIVE.includes(r.status)) throw new ValidationError(`This request is already ${r.status}`);
    if (r.source === 'vacation_tracker' && await this._vtSyncOnFor(r.email)) {
      throw new ValidationError('This came from Vacation Tracker. Change or cancel it there; Ticket Pulse follows within the hour.');
    }
    const updated = await prisma.avRequest.update({
      where: { id: r.id },
      data: { status: 'cancelled', events: { create: { kind: 'cancelled', actor: lc(user.email), details: reason ? { reason } : null } } },
    });
    await this.unproject(updated).catch((err) => logger.warn(`Availability: unprojection failed for request ${r.id}: ${err.message}`));
    if (r.status === 'approved') vtWriteBack.pushCancelled(updated.id, reason); // never throws
    if (!mine) {
      this._notifyRequester(updated, user).catch(() => {});
      this._teamsDecided(updated, user).catch(() => {});
    }
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

  /**
   * Request history for admins (QA 10-21 #1): every request of the people in
   * the workspace on screen (or one person), any status, newest first, with
   * how it reached Vacation Tracker and its event trail. Filters: person,
   * status, leave type and a date window the request overlaps.
   */
  async requestHistory(user, { email = null, status = null, leaveTypeId = null, from = null, to = null, workspaceId = null, limit = 200 } = {}) {
    await this.assertAdmin(user);
    let emails;
    if (email) {
      if (!(await this.canManagePerson(user, email))) throw new AuthorizationError('You can look up people in the workspaces you administer', 'availability_not_your_team');
      emails = [lc(email)];
    } else {
      emails = [...(await this.rosterFor(user, workspaceId))].map(lc);
    }
    if (!emails.length) return { requests: [], truncated: false };
    const where = { email: { in: emails, mode: 'insensitive' } };
    if (status && ['approved', 'pending', 'denied', 'cancelled'].includes(status)) where.status = status;
    if (Number(leaveTypeId) > 0) where.leaveTypeId = Number(leaveTypeId);
    if (from) where.endDate = { gte: toDay(from) };
    if (to) where.startDate = { lte: toDay(to) };
    const take = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const rows = await prisma.avRequest.findMany({
      where,
      include: { events: { orderBy: { createdAt: 'asc' }, take: 40 } },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const truncated = rows.length > take;
    const shown = rows.slice(0, take);
    const people = await prisma.avPerson.findMany({ where: { email: { in: [...new Set(shown.map((r) => r.email))] } }, select: { email: true, name: true } });
    const nameOf = new Map(people.map((p) => [lc(p.email), p.name]));
    return {
      requests: shown.map((r) => ({ ...serializeRequest(r), name: nameOf.get(lc(r.email)) || null, vacationTracker: vacationTrackerState(r) })),
      truncated,
    };
  }

  /**
   * Pending requests this person may decide. `mine` marks the ones they are a
   * named approver for; a super admin also gets the rest (they can step in),
   * each with who it is waiting on and the person's team, so a request from
   * another team never looks like it belongs to the workspace on screen
   * (QA 10-13 #8).
   */
  async listPendingFor(user) {
    const stepIn = await this.isSuperAdmin(user);
    const rows = await prisma.avRequest.findMany({ where: { status: 'pending' }, orderBy: { startDate: 'asc' }, take: 500 });
    const out = [];
    for (const r of rows) {
      if (lc(r.email) === lc(user.email)) continue;
      const approvers = await this.approversFor(r.email);
      const mine = approvers.includes(lc(user.email));
      if (!mine && !stepIn) continue;
      out.push({ ...serializeRequest(r), mine, waitingOn: mine ? [] : approvers });
    }
    if (out.length) {
      const requesters = [...new Set(out.map((r) => r.email))];
      const everyone = [...new Set([...requesters, ...out.flatMap((r) => r.waitingOn)])];
      const [people, techs] = await Promise.all([
        prisma.avPerson.findMany({ where: { email: { in: everyone } }, select: { email: true, name: true } }),
        // The team is a label; a failed lookup must not hide the approvals.
        Promise.resolve().then(() => prisma.technician.findMany({ where: { isActive: true, email: { in: requesters, mode: 'insensitive' } }, select: { email: true, workspace: { select: { name: true } } }, take: 2000 })).catch(() => []),
      ]);
      const nameOf = new Map(people.map((p) => [p.email, p.name]));
      const teamsOf = new Map();
      for (const t of techs || []) {
        const e = lc(t.email);
        const name = t.workspace?.name;
        if (!name) continue;
        if (!teamsOf.has(e)) teamsOf.set(e, []);
        if (!teamsOf.get(e).includes(name)) teamsOf.get(e).push(name);
      }
      for (const r of out) {
        r.name = nameOf.get(r.email) || null; // approvers see a name, not just an e-mail
        r.teams = teamsOf.get(lc(r.email)) || [];
        r.waitingOn = r.waitingOn.map((e) => ({ email: e, name: nameOf.get(e) || null }));
      }
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

  async balanceReport(user, { year = null, workspaceId = null } = {}) {
    await this.assertAdmin(user);
    // QA 10-05 #2: the workspace's own people, not the whole company.
    // QA 10-13 #8: and only for a workspace this person administers.
    if (!(await this._privilegedIn(user, workspaceId))) return [];
    const roster = await this.rosterFor(user, workspaceId);
    const people = (await this.listPeople()).filter((p) => roster.has(lc(p.email)));
    const out = [];
    for (const p of people) out.push({ email: p.email, name: p.name, balances: await this.balances(p.email, { year }) });
    return out;
  }

  async adjustBalance(input, actor) {
    await this.assertAdmin(actor);
    if (!(await this.canManagePerson(actor, input.email))) throw new AuthorizationError('You can adjust balances for people in the workspaces you administer', 'availability_not_your_team');
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
  async calendar(user, { from, to, officeId = null, groupId = null, workspaceId = null }) {
    const start = toDay(from);
    const end = toDay(to);
    if (!start || !end || end < start) throw new ValidationError('Pick a date range');
    if (daysSpan(start, end) > 93) throw new ValidationError('Show at most three months at a time');
    // QA 10-13 #8: waiting requests and private types show to the admins of
    // THIS workspace (and super admins), not to an admin of some other one.
    const admin = await this._privilegedIn(user, workspaceId);
    const roster = await this.rosterFor(user, workspaceId);
    let people = await prisma.avPerson.findMany({ where: { isActive: true, email: { in: [...roster] }, ...(officeId ? { officeId: Number(officeId) } : {}) }, orderBy: { name: 'asc' }, select: { email: true, name: true, officeId: true }, take: 2000 });
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
      // Waiting requests are for the people who decide them (Vahid, 5 Oct 2026).
      if (r.status === 'pending' && !privileged) continue;
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
    const holidayNames = await this._holidayNames(start, end);
    const holidays = Object.keys(holidayNames);
    return { from: dayKey(start), to: dayKey(end), people, entries, holidays, holidayNames, canSeePending: admin || approverOf.size > 0 };
  }

  /** Who is out today (OFF / WFH / ONSITE) — for the dashboard strip and Teams digest. */
  async outToday(user, { date = new Date(), workspaceId = null } = {}) {
    const d = dayKey(date);
    const cal = await this.calendar(user, { from: d, to: d, workspaceId });
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
    // One copy each: approvers do not see each other and Reply All goes nowhere.
    const subject = `Availability: ${person.name} — ${leaveType.name}, ${range}`;
    const sent = await Promise.allSettled([...new Set(approvers.map(lc).filter(Boolean))].map((to) => sendEmail({ to: [to], subject, html, context: 'availability' })));
    const failed = sent.filter((r) => r.status === 'rejected');
    if (failed.length) logger.warn(`Availability: ${failed.length} of ${sent.length} approver notice(s) failed for request ${request.id}: ${failed[0].reason?.message}`);
  }

  // Teams (QA 10-13 #6): the same moments, in the person's chat with the bot.
  // Each is a choice in their own Teams settings; none of these ever throws.

  async _teamsSubmitted(request, leaveType, person, actor, approvers = []) {
    const range = `${describeRange(request)} · ${describeAmount(request, leaveType)}`;
    const byOther = lc(actor?.email) !== lc(person.email);
    const approved = request.status === 'approved';
    let waiting = null;
    if (!approved && approvers.length) {
      const people = await prisma.avPerson.findMany({ where: { email: { in: approvers } }, select: { email: true, name: true } }).catch(() => []);
      const nameOf = new Map(people.map((p) => [p.email, p.name]));
      waiting = `Waiting for ${approvers.map((e) => nameOf.get(e) || e).join(' or ')}.`;
    }
    await availabilityTeams.notify(person.email, 'av_submitted', {
      title: `${approved ? 'Booked' : 'Sent for approval'}: ${leaveType.name}`,
      lines: [range, byOther ? `Booked for you by ${actor?.name || actor?.email}.` : null, waiting, request.decision?.reason || null],
      refKey: `av:${request.id}:submitted`,
      path: '/availability/my-time',
      icon: approved ? '✅' : '🕓',
    });
    if (!approved) {
      for (const to of [...new Set(approvers.map(lc).filter(Boolean))]) {
        await availabilityTeams.notify(to, 'av_approval_waiting', {
          title: `${person.name} asked for ${leaveType.name.toLowerCase()}`,
          lines: [range, request.note ? `Note: ${request.note}` : null, request.decision?.reason ? `Why it needs you: ${request.decision.reason}` : null],
          refKey: `av:${request.id}:approval`,
          path: '/availability/approvals',
          button: 'Review the request',
          icon: '🙋',
        });
      }
    }
  }

  async _teamsDecided(request, actor) {
    const type = await prisma.avLeaveType.findUnique({ where: { id: request.leaveTypeId } });
    const word = request.status === 'approved' ? 'Approved' : request.status === 'denied' ? 'Denied' : 'Cancelled';
    await availabilityTeams.notify(request.email, 'av_decided', {
      title: `${word}: ${type?.name || 'time away'}`,
      lines: [
        `${describeRange(request)} · ${describeAmount(request, type)}`,
        `By ${actor?.name || actor?.email || 'an approver'}.`,
        request.decisionNote ? `Note: ${request.decisionNote}` : null,
      ],
      refKey: `av:${request.id}:${request.status}`,
      path: '/availability/my-time',
      icon: request.status === 'approved' ? '✅' : '🚫',
    });
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

    // Leaves Ticket Pulse wrote to Vacation Tracker itself (write-back, 13 Oct
    // 2026) belong to their own request: never imported a second time.
    const written = new Map((await prisma.avRequest.findMany({
      where: { source: { not: 'vacation_tracker' }, externalId: { startsWith: 'vt:' } },
      select: { id: true, externalId: true, status: true, startDate: true, updatedAt: true },
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
      if (written.has(externalId)) { seen.add(externalId); skipped += 1; continue; }
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
      // A leave Ticket Pulse wrote that someone then cancelled in Vacation
      // Tracker: follow it. Two hours' grace so a fresh write is never undone
      // by a listing that has not caught up.
      const grace = Date.now() - 2 * 3600 * 1000;
      for (const r of written.values()) {
        if (r.status !== 'approved' || seen.has(r.externalId) || new Date(r.updatedAt).getTime() > grace) continue;
        if (toDay(r.startDate) < windowStart || toDay(r.startDate) > windowEnd) continue;
        await this._cancelSynced(r, 'Cancelled in Vacation Tracker', actorEmail);
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

/**
 * Where a request stands with Vacation Tracker, in words (QA 10-21 #1):
 * imported from it, written to it, or why not.
 */
export function vacationTrackerState(r) {
  if (r.source === 'vacation_tracker') return { state: 'imported', label: 'Came from Vacation Tracker' };
  const vt = (r.events || []).filter((e) => String(e.kind || '').startsWith('vt_'));
  const last = vt[vt.length - 1] || null;
  if (last?.kind === 'vt_cancelled') return { state: 'cancelled', label: 'Cancelled in Vacation Tracker too' };
  if (isVtExternalId(r.externalId) || last?.kind === 'vt_written') return { state: 'written', label: 'Added to Vacation Tracker' };
  if (last?.kind === 'vt_write_skipped') {
    const reason = String(last.details?.reason || '');
    const type = /matches "([^"]+)"/.exec(reason)?.[1];
    if (type) return { state: 'skipped', label: `Not in Vacation Tracker: it has no "${type}" leave type` };
    if (/not a vacation tracker user/i.test(reason)) return { state: 'skipped', label: 'Not in Vacation Tracker: this person is not a user there' };
    return { state: 'skipped', label: `Not in Vacation Tracker${reason ? `: ${reason}` : ''}` };
  }
  if (last?.kind === 'vt_write_failed') return { state: 'failed', label: `Vacation Tracker refused it: ${String(last.details?.error || 'unknown error').slice(0, 160)}` };
  if (r.status !== 'approved') return { state: 'not_sent', label: 'Only approved requests go to Vacation Tracker' };
  return { state: 'waiting', label: 'Not sent to Vacation Tracker yet' };
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
    inVacationTracker: isVtExternalId(r.externalId),
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

export function describeAmount(r, type = null) {
  if (type?.unit === 'hour' || r.dayPart === 'hours') {
    const h = num(r.hours);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = num(r.days);
  return `${d} day${d === 1 ? '' : 's'}`;
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
