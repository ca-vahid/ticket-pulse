import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import {
  DETECTION_RULES, HR_SENDERS, NOTICE_EFFECT, classifyHrNotice, localDate, normalizePersonName, stripSecrets,
} from '../utils/hrNoticeClassifier.js';

/**
 * HR lifecycle — Onboarding / Offboarding (plans/HR_LIFECYCLE_PLAN.md, QA 10-01 #8).
 *
 * The HR notice ticket is the parent of a "family": TP-born child tickets
 * (Laptop, Phone, iPad, Disable Account, Decommissioning Account for a
 * departure; Laptop + Workstation for a new hire) linked parent/child, with
 * due dates from the notice and default assignees from Settings. Change
 * notices move every open member's due date, cancellations close the family,
 * the NH automation's tickets are linked, never duplicated.
 *
 * Ships disabled. Per workspace: mode off | observe | live.
 *   off      nothing happens (the default; no settings row = off)
 *   observe  every handled notice writes ONE hr_lifecycle_events row holding
 *            the family it would have built — no ticket is touched
 *   live     the family is built and kept in step
 *
 * Where the section exists at all: HR_LIFECYCLE_WORKSPACE_IDS (comma list,
 * default "1" = IT). Other workspaces get 404 from the routes and the creation
 * hook returns at once.
 *
 * Everything here is best-effort from the ticket-creation hook: a failure is
 * recorded as an event with outcome 'failed' and never reaches the caller.
 * New-table reads degrade to "nothing" while the hand-applied migration is
 * missing (Promise.resolve().then(...).catch()).
 */

export const HR_LIFECYCLE_MODES = Object.freeze(['off', 'observe', 'live']);
const TERMINAL_BASE_STATUSES = ['Resolved', 'Closed'];
export const TEMPLATE_NAMES = Object.freeze(['offboarding_standard', 'offboarding_after_fact', 'onboarding']);
export const TEMPLATE_LABELS = Object.freeze({
  offboarding_standard: 'Offboarding',
  offboarding_after_fact: 'Offboarding — after the fact',
  onboarding: 'Onboarding',
});
export const HR_LIFECYCLE_ACTOR = Object.freeze({ name: 'Ticket Pulse (Onboarding)', role: 'automation' });

/** Only tickets created in the last few days start anything (history backfills must not). */
const RECENT_DAYS = 3;
const MAX_CHILDREN = 12;
const MAX_BODY_CHARS = 6000;
const DUE_LOCAL_TIME = '17:00:00';
const MAX_ASSIGNEES = 6;
// Organise now: how far back existing child / NH tickets are looked for.
const ADOPT_LOOKBACK_DAYS = 180;
const CANDIDATE_LIMIT = 40;

// Seeded from today's routing (research §3 "Assignees"): accounts go to the
// identity/M365 owner, the phone to the phone owner, devices to the office
// tech (blank = normal AI routing). Names resolve to technicians in the
// workspace when settings are first shown; nothing is stored until saved.
const DEFAULT_TEMPLATES = Object.freeze({
  offboarding_standard: [
    { key: 'laptop', title: 'Laptop', dueOffsetDays: 0 },
    { key: 'phone', title: 'Phone', dueOffsetDays: 0, assigneeHint: 'Gaby Tonnova' },
    { key: 'ipad', title: 'iPad', dueOffsetDays: 0 },
    { key: 'disable_account', title: 'Disable Account', dueOffsetDays: 0, assigneeHint: 'Muhammad Shahidullah' },
    { key: 'decommission_account', title: 'Decommissioning Account', dueOffsetDays: 7, assigneeHint: 'Muhammad Shahidullah' },
  ],
  offboarding_after_fact: [
    { key: 'laptop', title: 'Laptop', dueOffsetDays: 0 },
    { key: 'phone', title: 'Phone', dueOffsetDays: 0, assigneeHint: 'Gaby Tonnova' },
    { key: 'ipad', title: 'iPad', dueOffsetDays: 0 },
  ],
  onboarding: [
    { key: 'laptop', title: 'Laptop', dueOffsetDays: 0 },
    { key: 'workstation', title: 'Workstation', dueOffsetDays: 0 },
  ],
});
const DEFAULT_PARENT_HINT = 'Vahid Haeri';

// The intro line of each child (FreshService wording the team already knows).
const CHILD_INTRO = {
  laptop: { offboarding: 'Please take the necessary steps to retrieve the laptop from the following user.', onboarding: 'Please set up a laptop for the following new hire.' },
  phone: { offboarding: 'Please take the necessary steps to retrieve the phone from the following user.', onboarding: 'Please set up a phone for the following new hire.' },
  ipad: { offboarding: 'Please take the necessary steps to retrieve the iPad from the following user.', onboarding: 'Please set up an iPad for the following new hire.' },
  disable_account: { offboarding: 'Please proceed with disabling the account of the following user.' },
  decommission_account: { offboarding: 'Please proceed with the decommissioning of the following user by retrieving licenses, removing from groups, and completing other necessary offboarding actions.' },
  workstation: { onboarding: 'Please contact the admin team to get the desk number and set up the workstation for the following new hire.' },
};

const FAMILY_KIND_LABEL = { offboarding: 'offboarding', onboarding: 'onboarding' };

// ---------------------------------------------------------------- helpers

export function availableWorkspaceIds() {
  const raw = process.env.HR_LIFECYCLE_WORKSPACE_IDS ?? '1';
  return new Set(String(raw).split(',').map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0));
}

export function isAvailable(workspaceId) {
  return availableWorkspaceIds().has(Number(workspaceId));
}

/** A child's people: the stored list, else the single legacy assignee. */
export function assigneeIds(item) {
  const raw = Array.isArray(item?.assigneeTechIds) && item.assigneeTechIds.length
    ? item.assigneeTechIds
    : (item?.assigneeTechId ? [item.assigneeTechId] : []);
  return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

const soft = (fn, fallback = null) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`HR lifecycle read degraded: ${err.message}`);
  return fallback;
});

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** 17:00 local on `iso` in the workspace time zone, as an ISO instant. */
export function dueInstant(iso, timeZone = 'America/Los_Angeles') {
  if (!iso) return null;
  let offset = 'Z';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(`${iso}T12:00:00Z`));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
    if (m) offset = `${m[1]}:${m[2] || '00'}`;
  } catch { /* UTC */ }
  return new Date(`${iso}T${DUE_LOCAL_TIME}${offset}`).toISOString();
}

const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function plainBody(ticket) {
  const raw = ticket?.descriptionText
    || String(ticket?.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return stripSecrets(String(raw || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_BODY_CHARS);
}

/** A short, password-free quote of a notice for notes. */
export function noticeQuote(ticket, max = 400) {
  const body = plainBody(ticket).replace(/\s+/g, ' ');
  const cut = body.length > max ? `${body.slice(0, max)}…` : body;
  return cut;
}

function fmtDay(iso) {
  if (!iso) return 'no date';
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function slugKey(title) {
  return String(title || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'task';
}

// ---------------------------------------------------------------- service

class HrLifecycleService {
  constructor() {
    this._inFlight = new Set();
  }

  async _ticketService() { return (await import('./ticketService.js')).default; }
  async _linkService() { return (await import('./ticketLinkService.js')).default; }
  async _parkService() { return (await import('./ticketParkService.js')).default; }

  async _timeZone(workspaceId) {
    const ws = await soft(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { defaultTimezone: true } }));
    return ws?.defaultTimezone || 'America/Los_Angeles';
  }

  async _technicians(workspaceId) {
    return soft(() => prisma.technician.findMany({
      where: { workspaceId: Number(workspaceId), isActive: true },
      select: { id: true, name: true, email: true, photoUrl: true },
      orderBy: { name: 'asc' },
    }), []);
  }

  async _groups(workspaceId) {
    return soft(() => prisma.group.findMany({
      where: { workspaceId: Number(workspaceId), isActive: true },
      select: { id: true, name: true, origin: true },
      orderBy: { name: 'asc' },
    }), []);
  }

  // ------------------------------------------------------------ settings

  _defaults(techs = []) {
    const byName = new Map(techs.map((t) => [normalizePersonName(t.name), t.id]));
    const resolve = (hint) => (hint ? byName.get(normalizePersonName(hint)) ?? null : null);
    const templates = {};
    for (const name of TEMPLATE_NAMES) {
      templates[name] = DEFAULT_TEMPLATES[name].map(({ assigneeHint, ...item }) => {
        const id = resolve(assigneeHint);
        return { ...item, assigneeTechId: id, assigneeTechIds: id ? [id] : [], groupId: null };
      });
    }
    return {
      mode: 'off',
      parentAssigneeTechId: resolve(DEFAULT_PARENT_HINT),
      templates,
      leave: { assigneeTechId: null, park: true },
      officeChange: { assigneeTechId: null, park: true },
    };
  }

  _normalize(row, defaults) {
    const templates = {};
    const stored = row?.templates && typeof row.templates === 'object' ? row.templates : {};
    for (const name of TEMPLATE_NAMES) {
      templates[name] = Array.isArray(stored[name]) ? stored[name].map((i) => {
        const ids = assigneeIds(i);
        return {
          key: String(i.key), title: String(i.title), dueOffsetDays: Number(i.dueOffsetDays) || 0,
          assigneeTechId: ids[0] ?? null, assigneeTechIds: ids, groupId: i.groupId ? Number(i.groupId) : null,
        };
      }) : defaults.templates[name];
    }
    const side = (v, d) => ({
      assigneeTechId: v?.assigneeTechId ? Number(v.assigneeTechId) : (v ? null : d.assigneeTechId),
      park: v ? v.park !== false : d.park,
    });
    return {
      mode: HR_LIFECYCLE_MODES.includes(row?.mode) ? row.mode : defaults.mode,
      parentAssigneeTechId: row ? (row.parentAssigneeTechId ?? null) : defaults.parentAssigneeTechId,
      templates,
      leave: side(row?.leave, defaults.leave),
      officeChange: side(row?.officeChange, defaults.officeChange),
    };
  }

  /** Effective settings (stored row, else the seeded defaults with mode off). */
  async getSettings(workspaceId, { withTechs = true } = {}) {
    const row = await soft(() => prisma.hrLifecycleSettings.findUnique({ where: { workspaceId: Number(workspaceId) } }));
    // Seeding the defaults needs the team; a stored row does not.
    const techs = row || !withTechs ? [] : await this._technicians(workspaceId);
    const settings = this._normalize(row, this._defaults(techs));
    return {
      workspaceId: Number(workspaceId),
      ...settings,
      persisted: Boolean(row),
      updatedAt: row?.updatedAt || null,
      updatedBy: row?.updatedBy || null,
    };
  }

  /** The mode alone — the hot path of the creation hook (one PK read). */
  async getMode(workspaceId) {
    const row = await soft(() => prisma.hrLifecycleSettings.findUnique({ where: { workspaceId: Number(workspaceId) }, select: { mode: true } }));
    return HR_LIFECYCLE_MODES.includes(row?.mode) ? row.mode : 'off';
  }

  async _validate(workspaceId, input, current) {
    const techs = await this._technicians(workspaceId);
    const groups = await this._groups(workspaceId);
    const techIds = new Set(techs.map((t) => t.id));
    const groupIds = new Set(groups.map((g) => g.id));
    const techOrNull = (v, where) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || !techIds.has(n)) throw new ValidationError(`${where}: pick an active technician in this workspace`);
      return n;
    };
    const groupOrNull = (v, where) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || !groupIds.has(n)) throw new ValidationError(`${where}: pick a group in this workspace`);
      return n;
    };

    const next = JSON.parse(JSON.stringify({
      mode: current.mode, parentAssigneeTechId: current.parentAssigneeTechId, templates: current.templates, leave: current.leave, officeChange: current.officeChange,
    }));
    if (input.mode !== undefined) {
      if (!HR_LIFECYCLE_MODES.includes(input.mode)) throw new ValidationError(`Mode must be one of: ${HR_LIFECYCLE_MODES.join(', ')}`);
      next.mode = input.mode;
    }
    if (input.parentAssigneeTechId !== undefined) next.parentAssigneeTechId = techOrNull(input.parentAssigneeTechId, 'Parent assignee');
    if (input.templates !== undefined) {
      if (!input.templates || typeof input.templates !== 'object') throw new ValidationError('templates must be an object');
      for (const name of Object.keys(input.templates)) {
        if (!TEMPLATE_NAMES.includes(name)) throw new ValidationError(`Unknown child list: ${name}`);
        const list = input.templates[name];
        if (!Array.isArray(list)) throw new ValidationError(`${TEMPLATE_LABELS[name]}: the child list must be a list`);
        if (list.length > MAX_CHILDREN) throw new ValidationError(`${TEMPLATE_LABELS[name]}: at most ${MAX_CHILDREN} children`);
        const seen = new Set();
        next.templates[name] = list.map((item, i) => {
          const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
          if (!title || title.length > 120) throw new ValidationError(`${TEMPLATE_LABELS[name]} #${i + 1}: a title of 1–120 characters is required`);
          let key = String(item?.key || '').trim() || slugKey(title);
          if (!/^[a-z0-9_]{1,40}$/.test(key)) key = slugKey(key);
          if (seen.has(key)) throw new ValidationError(`${TEMPLATE_LABELS[name]}: "${title}" is listed twice`);
          seen.add(key);
          const offset = Number(item?.dueOffsetDays ?? 0);
          if (!Number.isInteger(offset) || offset < -30 || offset > 90) throw new ValidationError(`${TEMPLATE_LABELS[name]} — ${title}: due offset must be a whole number of days between -30 and 90`);
          // Several people may share a child: they take turns (see _pickAssignee).
          // A page that only knows the single field (an older tab) sends a stale list: the single field wins then.
          const listed = Array.isArray(item?.assigneeTechIds) ? item.assigneeTechIds : null;
          const agrees = listed && (item.assigneeTechId === undefined || Number(listed[0] || 0) === Number(item.assigneeTechId || 0));
          const rawIds = agrees ? listed : [item?.assigneeTechId];
          const ids = [...new Set(rawIds.map((v) => techOrNull(v, `${TEMPLATE_LABELS[name]} — ${title}`)).filter(Boolean))];
          if (ids.length > MAX_ASSIGNEES) throw new ValidationError(`${TEMPLATE_LABELS[name]} — ${title}: at most ${MAX_ASSIGNEES} people`);
          return {
            key,
            title,
            dueOffsetDays: offset,
            assigneeTechId: ids[0] ?? null,
            assigneeTechIds: ids,
            groupId: groupOrNull(item?.groupId, `${TEMPLATE_LABELS[name]} — ${title}`),
          };
        });
      }
    }
    for (const side of ['leave', 'officeChange']) {
      if (input[side] === undefined) continue;
      const v = input[side] || {};
      next[side] = {
        assigneeTechId: v.assigneeTechId !== undefined ? techOrNull(v.assigneeTechId, side === 'leave' ? 'Leave assignee' : 'Office change assignee') : next[side].assigneeTechId,
        park: v.park !== undefined ? v.park !== false : next[side].park,
      };
    }
    return next;
  }

  /** Field-level diff for the audit (path, before, after). */
  diffSettings(before, after) {
    const changes = [];
    const push = (field, a, b) => {
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes.push({ field, before: a ?? null, after: b ?? null });
    };
    push('mode', before.mode, after.mode);
    push('parentAssigneeTechId', before.parentAssigneeTechId, after.parentAssigneeTechId);
    for (const side of ['leave', 'officeChange']) {
      push(`${side}.assigneeTechId`, before[side]?.assigneeTechId, after[side]?.assigneeTechId);
      push(`${side}.park`, before[side]?.park, after[side]?.park);
    }
    for (const name of TEMPLATE_NAMES) {
      const a = before.templates?.[name] || [];
      const b = after.templates?.[name] || [];
      const aBy = new Map(a.map((i) => [i.key, i]));
      const bBy = new Map(b.map((i) => [i.key, i]));
      for (const item of a) if (!bBy.has(item.key)) changes.push({ field: `templates.${name}[${item.key}]`, before: item, after: null });
      for (const item of b) {
        const prev = aBy.get(item.key);
        if (!prev) { changes.push({ field: `templates.${name}[${item.key}]`, before: null, after: item }); continue; }
        for (const f of ['title', 'dueOffsetDays']) push(`templates.${name}[${item.key}].${f}`, prev[f], item[f]);
        const was = assigneeIds(prev);
        const now = assigneeIds(item);
        if (was.length > 1 || now.length > 1) push(`templates.${name}[${item.key}].assigneeTechIds`, was, now);
        else push(`templates.${name}[${item.key}].assigneeTechId`, was[0], now[0]);
        push(`templates.${name}[${item.key}].groupId`, prev.groupId, item.groupId);
      }
      const order = (list) => list.map((i) => i.key).filter((k) => aBy.has(k) && bBy.has(k));
      if (JSON.stringify(order(a)) !== JSON.stringify(order(b))) push(`templates.${name}.order`, order(a), order(b));
    }
    return changes;
  }

  /** Save settings; every changed field is audited (who / when / before → after). */
  async updateSettings(workspaceId, input = {}, actor = null) {
    const ws = Number(workspaceId);
    const current = await this.getSettings(ws);
    const next = await this._validate(ws, input || {}, current);
    const changes = this.diffSettings(current, next);
    if (!changes.length && current.persisted) return { settings: current, changes: [] };
    const who = actor?.email || actor?.name || null;
    const data = {
      mode: next.mode,
      parentAssigneeTechId: next.parentAssigneeTechId,
      templates: next.templates,
      leave: next.leave,
      officeChange: next.officeChange,
      updatedBy: who,
    };
    await prisma.$transaction([
      prisma.hrLifecycleSettings.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, ...data }, update: data }),
      ...(changes.length ? [prisma.hrLifecycleSettingsChange.createMany({
        data: changes.map((c) => ({
          workspaceId: ws, changedBy: actor?.email || null, changedByName: actor?.name || null, field: c.field, before: c.before, after: c.after,
        })),
      })] : []),
    ]);
    logger.info(`HR lifecycle settings ws ${ws} changed by ${who || 'unknown'}: ${changes.map((c) => c.field).join(', ') || 'first save'}`);
    return { settings: await this.getSettings(ws), changes };
  }

  async listSettingsChanges(workspaceId, { limit = 100 } = {}) {
    return soft(() => prisma.hrLifecycleSettingsChange.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    }), []);
  }

  detectionRules() {
    return {
      senders: [...HR_SENDERS],
      rules: DETECTION_RULES.map(({ type, label, sender, subject, example, action }) => ({ type, label, sender, pattern: subject, example, action })),
      afterTheFact: 'A departure is after the fact when the notice arrives on or after the last day, or says "effective immediately".',
      matching: 'A person is matched by their BambooHR employee id first, then by their normalised name.',
      recency: `Only tickets created in the last ${RECENT_DAYS} days are handled (history backfills never start a family).`,
      passwords: 'Lines that carry a password are removed from anything written into child descriptions or notes.',
      sharing: 'A child with several people goes to one of them: they take turns, and anyone off that day is skipped.',
    };
  }

  // ------------------------------------------------------------ tickets

  async _loadTicket(ticketId, workspaceId) {
    return soft(() => prisma.ticket.findFirst({
      where: { id: Number(ticketId), workspaceId: Number(workspaceId) },
      select: {
        id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true,
        description: true, descriptionText: true, status: true, priority: true, dueBy: true, createdAt: true,
        assignedTechId: true, requesterId: true, parkedUntil: true,
        requester: { select: { email: true, name: true } },
      },
    }));
  }

  async _isTerminal(workspaceId, status) {
    if (['Deleted', 'Spam'].includes(status)) return true;
    const base = await Promise.resolve().then(() => statusService.baseStatusOf(workspaceId, status)).catch(() => null);
    return TERMINAL_BASE_STATUSES.includes(base || status);
  }

  _isNative(t) { return t?.origin === 'ticketpulse'; }

  async _assign(t, techId, out) {
    if (!techId || Number(t.assignedTechId) === Number(techId)) return;
    try {
      const svc = await this._ticketService();
      if (this._isNative(t)) await svc.assignTicket(t.id, t.workspaceId, techId, HR_LIFECYCLE_ACTOR);
      else await svc.updateFsTicket(t.id, t.workspaceId, { assignedTechId: techId }, HR_LIFECYCLE_ACTOR);
      t.assignedTechId = techId;
    } catch (err) {
      out.warnings.push(`Assigning ${ticketDisplayRef(t)} failed: ${err.message}`);
    }
  }

  async _setDue(t, iso, tz, out) {
    if (!iso) return;
    const due = dueInstant(iso, tz);
    if (t.dueBy && Math.abs(new Date(t.dueBy).getTime() - new Date(due).getTime()) < 60e3) return;
    try {
      const svc = await this._ticketService();
      if (this._isNative(t)) await svc.updateTicketFields(t.id, t.workspaceId, { dueBy: due }, HR_LIFECYCLE_ACTOR);
      else await svc.updateFsTicket(t.id, t.workspaceId, { dueBy: due }, HR_LIFECYCLE_ACTOR);
      t.dueBy = due;
    } catch (err) {
      out.warnings.push(`Due date on ${ticketDisplayRef(t)} not set: ${err.message}`);
    }
  }

  async _close(t, out) {
    try {
      const svc = await this._ticketService();
      if (this._isNative(t)) await svc.changeStatus(t.id, t.workspaceId, 'Closed', HR_LIFECYCLE_ACTOR);
      else await svc.updateFsTicket(t.id, t.workspaceId, { status: 'Closed' }, HR_LIFECYCLE_ACTOR);
      t.status = 'Closed';
      return true;
    } catch (err) {
      out.warnings.push(`Closing ${ticketDisplayRef(t)} failed: ${err.message}`);
      return false;
    }
  }

  async _note(t, html, out) {
    try {
      const svc = await this._ticketService();
      await svc.addPrivateNote(t.id, t.workspaceId, { bodyHtml: html }, HR_LIFECYCLE_ACTOR);
    } catch (err) {
      out.warnings.push(`Note on ${ticketDisplayRef(t)} failed: ${err.message}`);
    }
  }

  async _link(parent, related, out) {
    try {
      const links = await this._linkService();
      await links.link(parent.id, parent.workspaceId, { relatedTicketId: related.id, kind: 'related_to' }, HR_LIFECYCLE_ACTOR);
    } catch (err) {
      out.warnings.push(`Linking ${ticketDisplayRef(related)} to ${ticketDisplayRef(parent)} failed: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ families

  /**
   * Who gets this child. One person: that person. Several: they take turns
   * (whoever was given this kind of child longest ago), skipping anyone who
   * is off today while somebody else is in. Reads only.
   */
  async _pickAssignee(workspaceId, item, tz) {
    const ids = assigneeIds(item);
    if (ids.length <= 1) return ids[0] ?? null;
    const ws = Number(workspaceId);
    const today = new Date(`${localDate(new Date(), tz || 'America/Los_Angeles')}T00:00:00Z`);
    const off = await soft(() => prisma.technicianLeave.findMany({
      where: { technicianId: { in: ids }, leaveDate: today, status: 'APPROVED', category: 'OFF' },
      select: { technicianId: true, isFullDay: true },
      take: 50,
    }), []);
    const away = new Set((off || []).filter((l) => l.isFullDay !== false).map((l) => l.technicianId));
    const pool = ids.filter((id) => !away.has(id));
    const candidates = pool.length ? pool : ids;
    const recent = await soft(() => prisma.hrLifecycleFamilyMember.findMany({
      where: { workspaceId: ws, role: 'child', templateKey: item.key }, orderBy: { id: 'desc' }, take: 20, select: { id: true, ticketId: true },
    }), []) || [];
    const newestFirst = [...recent].sort((a, b) => b.id - a.id);
    const tickets = newestFirst.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: newestFirst.map((r) => r.ticketId) }, workspaceId: ws }, select: { id: true, assignedTechId: true },
    }), []) || [] : [];
    const owner = new Map(tickets.map((t) => [t.id, t.assignedTechId]));
    const lastTurn = (id) => {
      const i = newestFirst.findIndex((r) => Number(owner.get(r.ticketId)) === id);
      return i === -1 ? 1e9 : i;
    };
    return [...candidates].sort((a, b) => lastTurn(b) - lastTurn(a) || ids.indexOf(a) - ids.indexOf(b))[0];
  }

  /** NH automation tickets of the last months (one read, shared by a candidates run). */
  async _nhTickets(workspaceId) {
    return await soft(() => prisma.ticket.findMany({
      where: { workspaceId: Number(workspaceId), subject: { startsWith: 'NH ' }, createdAt: { gte: new Date(Date.now() - ADOPT_LOOKBACK_DAYS * 86400e3) } },
      select: {
        id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, description: true,
        descriptionText: true, status: true, createdAt: true, assignedTechId: true, requester: { select: { email: true } },
      },
      take: 300,
      orderBy: { id: 'desc' },
    }), []) || [];
  }

  /**
   * Tickets that already cover a family's work (Organise now): FreshService's
   * "Child Ticket - <title> - <notice subject>" tickets for a departure, the
   * automation's NH Laptop / NH Workstation tickets for a new hire. Closed
   * ones count (the work is done); deleted and spam do not. Reads only.
   */
  async _existingWork(ticket, c, kind, settings, tz, { nhTickets = null } = {}) {
    const ws = ticket.workspaceId;
    const found = [];
    if (kind === 'offboarding') {
      const known = new Map();
      for (const name of ['offboarding_standard', 'offboarding_after_fact']) {
        for (const item of settings.templates?.[name] || []) if (!known.has(item.title.toLowerCase())) known.set(item.title.toLowerCase(), item);
      }
      const subject = String(ticket.subject || '');
      const rows = subject ? await soft(() => prisma.ticket.findMany({
        where: {
          workspaceId: ws,
          id: { not: ticket.id },
          subject: { startsWith: 'Child Ticket', contains: subject.slice(0, 150) },
          createdAt: { gte: new Date(new Date(ticket.createdAt || Date.now()).getTime() - 86400e3) },
        },
        select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true, assignedTechId: true },
        take: 30,
        orderBy: { id: 'asc' },
      }), []) || [] : [];
      for (const t of rows) {
        if (['Deleted', 'Spam'].includes(t.status)) continue;
        const at = t.subject.indexOf(subject.slice(0, 150));
        if (!t.subject.startsWith('Child Ticket') || at < 0) continue;
        const title = t.subject.slice('Child Ticket'.length, at).replace(/^[\s\-–:]+|[\s\-–:]+$/g, '').replace(/\s+/g, ' ');
        if (!title) continue;
        const item = known.get(title.toLowerCase());
        found.push({ key: item?.key || slugKey(title), title: item?.title || title, dueOffsetDays: item?.dueOffsetDays ?? 0, ticket: t });
      }
    } else if (kind === 'onboarding') {
      const titles = new Map((settings.templates?.onboarding || []).map((i) => [i.key, i]));
      const name = normalizePersonName(c.person || '');
      for (const t of nhTickets || await this._nhTickets(ws)) {
        if (t.id === ticket.id || ['Deleted', 'Spam'].includes(t.status)) continue;
        const nc = this.classify(t, tz);
        if (!nc || nc.type !== 'nh_automation') continue;
        const sameId = c.employeeId && nc.employeeId && String(c.employeeId) === String(nc.employeeId);
        const sameName = !(c.employeeId && nc.employeeId) && name && nc.person && normalizePersonName(nc.person) === name;
        if (!sameId && !sameName) continue;
        const key = nc.nhKind === 'workstation' ? 'workstation' : 'laptop';
        if (found.some((f) => f.key === key)) continue;
        const item = titles.get(key);
        // Never carry the NH body along: it can hold the initial password.
        const card = { id: t.id, workspaceId: t.workspaceId, origin: t.origin, nativeNumber: t.nativeNumber, freshserviceTicketId: t.freshserviceTicketId, subject: t.subject, status: t.status, assignedTechId: t.assignedTechId };
        found.push({ key, title: item?.title || (key === 'workstation' ? 'Workstation' : 'Laptop'), dueOffsetDays: item?.dueOffsetDays ?? 0, ticket: card });
      }
    }
    for (const f of found) f.terminal = await this._isTerminal(ws, f.ticket.status);
    return found;
  }

  async findOpenFamily(workspaceId, kind, c) {
    const ws = Number(workspaceId);
    if (c?.employeeId) {
      const byId = await soft(() => prisma.hrLifecycleFamily.findFirst({
        where: { workspaceId: ws, kind, status: 'open', employeeId: String(c.employeeId) }, orderBy: { id: 'desc' },
      }));
      if (byId) return byId;
    }
    const key = normalizePersonName(c?.person);
    if (!key) return null;
    return soft(() => prisma.hrLifecycleFamily.findFirst({
      where: { workspaceId: ws, kind, status: 'open', personKey: key }, orderBy: { id: 'desc' },
    }));
  }

  /**
   * The newest family Shadow recorded for this person and kind (employee id
   * first, then the normalised name), excluding the ticket being handled.
   * Returns { eventId, ref, plan } or null.
   */
  async _findShadowFamily(workspaceId, kind, c, ticketId) {
    const ws = Number(workspaceId);
    const rows = await soft(() => prisma.hrLifecycleEvent.findMany({
      where: { workspaceId: ws, mode: 'observe', decision: { in: ['create_family', 'create_family_after_the_fact'] }, ticketId: { not: Number(ticketId) || undefined }, createdAt: { gte: new Date(Date.now() - 180 * 86400e3) } },
      orderBy: { id: 'desc' },
      take: 200,
      select: { id: true, ticketId: true, person: true, details: true },
    }), []);
    const key = normalizePersonName(c?.person || c?.username || '');
    const emp = c?.employeeId ? String(c.employeeId) : null;
    const hit = rows.find((r) => r.details?.plan?.familyKind === kind && emp && String(r.details?.classification?.employeeId || '') === emp)
      || rows.find((r) => r.details?.plan?.familyKind === kind && key && normalizePersonName(r.person || '') === key);
    if (!hit) return null;
    const parent = hit.ticketId ? await soft(() => prisma.ticket.findUnique({ where: { id: hit.ticketId }, select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true } })) : null;
    return { eventId: hit.id, ref: parent ? ticketDisplayRef(parent) : `ticket ${hit.ticketId}`, plan: hit.details?.plan || null };
  }

  /** Family members with their live ticket rows (+ the parent as role 'parent'). */
  async _familyTickets(family) {
    const members = await soft(() => prisma.hrLifecycleFamilyMember.findMany({ where: { familyId: family.id }, orderBy: { id: 'asc' } }), []);
    const ids = [...new Set([family.parentTicketId, ...members.map((m) => m.ticketId)].filter(Boolean))];
    const rows = ids.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: ids }, workspaceId: family.workspaceId },
      select: {
        id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true,
        dueBy: true, assignedTechId: true, parkedUntil: true, assignedTech: { select: { id: true, name: true, photoUrl: true } },
      },
    }), []) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parent = family.parentTicketId ? byId.get(family.parentTicketId) || null : null;
    const list = [];
    for (const m of members) {
      const t = byId.get(m.ticketId);
      if (!t) continue;
      list.push({ member: m, ticket: t, terminal: await this._isTerminal(family.workspaceId, t.status) });
    }
    return { parent, parentTerminal: parent ? await this._isTerminal(family.workspaceId, parent.status) : true, members: list };
  }

  // ------------------------------------------------------------ entry points

  /**
   * The ticket.created hook (ticketLifecycleNotificationService). Fire and
   * forget: never throws, returns the recorded event or null.
   */
  async onTicketCreated(ticketId, workspaceId) {
    try {
      if (!isAvailable(workspaceId)) return null;
      const mode = await this.getMode(workspaceId);
      if (mode === 'off') return null;
      return await this.handleTicket(ticketId, workspaceId, { mode });
    } catch (err) {
      logger.warn(`HR lifecycle: ticket ${ticketId} not handled: ${err.message}`);
      return null;
    }
  }

  /** Classify + plan without writing anything (POST /preview). */
  async preview(ticketId, workspaceId) {
    const ticket = await this._loadTicket(ticketId, workspaceId);
    if (!ticket) throw new NotFoundError('Ticket not found in this workspace');
    const tz = await this._timeZone(workspaceId);
    const c = this.classify(ticket, tz);
    if (!c) return { ticketId: ticket.id, ref: ticketDisplayRef(ticket), classification: null, plan: null };
    const settings = await this.getSettings(workspaceId);
    const shadow = (await this.getMode(workspaceId)) !== 'live';
    return { ticketId: ticket.id, ref: ticketDisplayRef(ticket), classification: c, plan: await this.plan(ticket, c, settings, tz, { shadow }) };
  }

  classify(ticket, tz) {
    return classifyHrNotice({
      subject: ticket.subject,
      text: ticket.descriptionText || String(ticket.description || '').replace(/<[^>]+>/g, ' '),
      requesterEmail: ticket.requester?.email || null,
      createdAt: ticket.createdAt,
      timeZone: tz,
    });
  }

  async handleTicket(ticketId, workspaceId, { mode = 'observe', force = false } = {}) {
    const ws = Number(workspaceId);
    const key = `${ws}:${ticketId}`;
    if (this._inFlight.has(key)) return null;
    this._inFlight.add(key);
    try {
      const ticket = await this._loadTicket(ticketId, ws);
      if (!ticket) return null;
      if (!force && ticket.createdAt && Date.now() - new Date(ticket.createdAt).getTime() > RECENT_DAYS * 86400e3) return null;
      const tz = await this._timeZone(ws);
      const c = this.classify(ticket, tz);
      if (!c) return null;
      const seen = await soft(() => prisma.hrLifecycleEvent.findFirst({
        where: { workspaceId: ws, ticketId: ticket.id, mode, outcome: { in: ['done', 'recorded'] } }, select: { id: true },
      }));
      if (seen && !force) return null;
      const settings = await this.getSettings(ws);
      const plan = await this.plan(ticket, c, settings, tz, { shadow: mode !== 'live' });
      if (mode !== 'live') {
        return this._record(ws, { ticket, c, plan, mode: 'observe', outcome: 'recorded', summary: `Would: ${plan.summary}` });
      }
      return await this.execute(ticket, c, plan, settings, tz);
    } finally {
      this._inFlight.delete(key);
    }
  }

  /** What a notice would do. Reads only. */
  async plan(ticket, c, settings, tz, { shadow = false, adopt = false, nhTickets = null } = {}) {
    const ws = ticket.workspaceId;
    const fx = NOTICE_EFFECT[c.type];
    const person = c.person || c.username || 'this person';
    if (!fx) return { decision: 'ignored', summary: 'Not a lifecycle notice' };

    if (fx.effect === 'notice') {
      const side = fx.family === 'leave' ? settings.leave : settings.officeChange;
      const what = fx.family === 'leave' ? (c.type === 'leave_change' ? `leave ${c.changed} date change` : 'leave') : 'transfer';
      return {
        decision: 'notice_is_ticket',
        familyKind: fx.family,
        notice: { ticketId: ticket.id, assigneeTechId: side.assigneeTechId || null, dueDate: c.date || null, park: side.park !== false },
        summary: `${person}: ${what} — the notice is the ticket${c.date ? `, due ${fmtDay(c.date)}` : ''}${side.assigneeTechId ? ', assigned per settings' : ''}${side.park !== false && c.date ? ', parked until its lead time' : ''}`,
      };
    }

    const family = await this.findOpenFamily(ws, fx.family, c);
    // Shadow (1 Oct 2026): no real families exist, so a follow-up notice
    // looks for the family Shadow RECORDED for the same person and says what
    // Live would do to it — otherwise every NH ticket, date change and
    // cancellation would read "no family" and the rehearsal would mislead.
    const shadowFamily = !family && shadow ? await this._findShadowFamily(ws, fx.family, c, ticket.id) : null;
    if (shadowFamily) {
      const sp = shadowFamily.plan;
      const from = shadowFamily.ref;
      const tag = ` (from the family Shadow recorded on ${from})`;
      if (fx.effect === 'create') {
        return { decision: 'duplicate_linked', familyKind: fx.family, shadowOf: shadowFamily.eventId, summary: `${person}: HR sent this ${FAMILY_KIND_LABEL[fx.family]} notice again — would link to the open family, no new children${tag}` };
      }
      if (fx.effect === 'link') {
        return { decision: 'link_nh', familyKind: fx.family, shadowOf: shadowFamily.eventId, parentTicketId: sp?.parent?.ticketId || null, nhKind: c.nhKind, summary: `${person}: NH ${c.nhKind === 'workstation' ? 'Workstation' : 'Laptop'} ticket would be linked to the onboarding family, no new child${tag}` };
      }
      if (fx.effect === 'cancel') {
        const n = (sp?.children || []).length;
        return { decision: 'cancel_family', familyKind: fx.family, shadowOf: shadowFamily.eventId, closes: [], summary: `${person}: ${fx.family === 'onboarding' ? 'no longer starting' : 'no longer departing'} — would close the parent and ${n} ${n === 1 ? 'child' : 'children'}${tag}` };
      }
      if (fx.effect === 'move' || fx.effect === 'office') {
        if (!c.date && fx.effect === 'move') return { decision: 'no_date', familyKind: fx.family, shadowOf: shadowFamily.eventId, summary: `${person}: the change notice has no clear new date — left for a person${tag}` };
        const moves = c.date ? [
          ...(sp?.parent ? [{ ticketId: sp.parent.ticketId, role: 'parent', dueDate: c.date }] : []),
          ...(sp?.children || []).map((ch) => ({ ticketId: null, title: ch.title, role: 'child', dueDate: addDays(c.date, ch.dueOffsetDays || 0) })),
        ] : [];
        const fromDate = sp?.effectiveDate || sp?.parent?.dueDate || null;
        return {
          decision: fx.effect === 'office' ? 'office_changed' : 'move_dates',
          familyKind: fx.family, shadowOf: shadowFamily.eventId, fromDate, toDate: c.date || null, office: c.office || null, moves,
          summary: moves.length
            ? `${person}: would move ${moves.length} open tickets${fromDate ? ` from ${fmtDay(fromDate)}` : ''} to ${fmtDay(c.date)} and note each${fx.effect === 'office' && c.office ? `; office now ${c.office}` : ''}${tag}`
            : `${person}: office changed${c.office ? ` to ${c.office}` : ''} — would note every open ticket${tag}`,
        };
      }
    }

    if (fx.effect === 'create') {
      if (family) {
        return { decision: 'duplicate_linked', familyId: family.id, familyKind: fx.family, summary: `${person}: HR sent this ${FAMILY_KIND_LABEL[fx.family]} notice again — linked to the open family (no new children)` };
      }
      const afterTheFact = fx.family === 'offboarding' && Boolean(c.effectiveImmediately || (c.date && c.noticeDate && c.date <= c.noticeDate));
      const template = fx.family === 'onboarding' ? 'onboarding' : (afterTheFact ? 'offboarding_after_fact' : 'offboarding_standard');
      // After the fact the last day is already past: the work is due from today.
      const baseDate = c.date ? (c.noticeDate && c.date < c.noticeDate ? c.noticeDate : c.date) : (afterTheFact ? c.noticeDate : null);
      const children = [];
      for (const item of settings.templates[template] || []) {
        const ids = assigneeIds(item);
        children.push({
          key: item.key,
          title: item.title,
          dueOffsetDays: item.dueOffsetDays,
          dueDate: baseDate ? addDays(baseDate, item.dueOffsetDays) : null,
          assigneeTechId: await this._pickAssignee(ws, item, tz),
          ...(ids.length > 1 ? { assigneeTechIds: ids } : {}),
          groupId: item.groupId || null,
          subject: `Child Ticket - ${item.title} - ${ticket.subject}`.slice(0, 500),
        });
      }
      // Organise now: tickets that already exist are taken in, never duplicated.
      if (adopt) {
        const existing = await this._existingWork(ticket, c, fx.family, settings, tz, { nhTickets });
        const card = (e) => ({ adoptTicketId: e.ticket.id, adoptRef: ticketDisplayRef(e.ticket), adoptStatus: e.ticket.status, adoptClosed: e.terminal, adoptOrigin: e.ticket.origin || null });
        const used = new Set();
        for (const child of children) {
          const hit = existing.find((e) => e.key === child.key && !used.has(e.ticket.id));
          if (!hit) continue;
          used.add(hit.ticket.id);
          Object.assign(child, card(hit));
        }
        for (const e of existing) {
          if (used.has(e.ticket.id)) continue;
          children.push({ key: e.key, title: e.title, dueOffsetDays: e.dueOffsetDays, dueDate: baseDate ? addDays(baseDate, e.dueOffsetDays) : null, assigneeTechId: null, groupId: null, subject: e.ticket.subject, ...card(e) });
        }
      }
      const taken = children.filter((x) => x.adoptTicketId);
      const fresh = children.filter((x) => !x.adoptTicketId);
      const why = afterTheFact ? (c.effectiveImmediately ? ' (after the fact: "effective immediately")' : ' (after the fact: the notice arrived on/after the last day)') : '';
      return {
        decision: afterTheFact ? 'create_family_after_the_fact' : 'create_family',
        familyKind: fx.family,
        template,
        afterTheFact,
        effectiveDate: c.date || null,
        parent: { ticketId: ticket.id, assigneeTechId: settings.parentAssigneeTechId || null, dueDate: baseDate },
        children,
        ...(adopt ? { adopt: true } : {}),
        summary: adopt
          ? `${person}: ${FAMILY_KIND_LABEL[fx.family]} family — ${taken.length} existing ${taken.length === 1 ? 'ticket' : 'tickets'} taken in${taken.length ? ` (${taken.map((x) => x.title).join(', ')})` : ''}, ${fresh.length} created${fresh.length ? ` (${fresh.map((x) => x.title).join(', ')})` : ''}${baseDate ? `, due ${fmtDay(baseDate)}` : ', no date in the notice'}${why}`
          : `${person}: ${FAMILY_KIND_LABEL[fx.family]} family with ${children.length} ${children.length === 1 ? 'child' : 'children'} (${children.map((x) => x.title).join(', ')})${baseDate ? `, due ${fmtDay(baseDate)}` : ', no date in the notice'}${why}`,
      };
    }

    if (!family) {
      return { decision: 'no_family', familyKind: fx.family, summary: `${person}: no open ${FAMILY_KIND_LABEL[fx.family]} family to ${fx.effect === 'link' ? 'link to' : 'update'} — left for a person` };
    }
    const fam = await this._familyTickets(family);
    const open = fam.members.filter((m) => !m.terminal);
    const openChildren = open.filter((m) => m.member.role === 'child');

    if (fx.effect === 'move' || (fx.effect === 'office' && c.date && c.date !== dateOnly(family.effectiveDate))) {
      if (!c.date) return { decision: 'no_date', familyId: family.id, familyKind: fx.family, summary: `${person}: the change notice has no clear new date — left for a person` };
      const moves = [
        ...(fam.parent && !fam.parentTerminal ? [{ ticketId: fam.parent.id, ref: ticketDisplayRef(fam.parent), dueDate: c.date, role: 'parent' }] : []),
        ...openChildren.map((m) => ({ ticketId: m.ticket.id, ref: ticketDisplayRef(m.ticket), dueDate: addDays(c.date, m.member.dueOffsetDays || 0), role: 'child' })),
      ];
      return {
        decision: fx.effect === 'office' ? 'office_changed' : 'move_dates',
        familyId: family.id,
        familyKind: fx.family,
        fromDate: dateOnly(family.effectiveDate),
        toDate: c.date,
        office: c.office || null,
        moves,
        summary: `${person}: move ${moves.length} open ${moves.length === 1 ? 'ticket' : 'tickets'} from ${fmtDay(dateOnly(family.effectiveDate))} to ${fmtDay(c.date)}${fx.effect === 'office' && c.office ? `; office now ${c.office}` : ''}`,
      };
    }
    if (fx.effect === 'office') {
      return { decision: 'office_changed', familyId: family.id, familyKind: fx.family, office: c.office || null, moves: [], summary: `${person}: office changed${c.office ? ` to ${c.office}` : ''} — note on every open ticket` };
    }
    if (fx.effect === 'cancel') {
      return {
        decision: 'cancel_family',
        familyId: family.id,
        familyKind: fx.family,
        closes: [
          ...openChildren.map((m) => ({ ticketId: m.ticket.id, ref: ticketDisplayRef(m.ticket), role: 'child' })),
          ...(fam.parent && !fam.parentTerminal ? [{ ticketId: fam.parent.id, ref: ticketDisplayRef(fam.parent), role: 'parent' }] : []),
        ],
        summary: `${person}: ${fx.family === 'onboarding' ? 'no longer starting' : 'no longer departing'} — close the parent and ${openChildren.length} open ${openChildren.length === 1 ? 'child' : 'children'}`,
      };
    }
    if (fx.effect === 'link') {
      return {
        decision: 'link_nh',
        familyId: family.id,
        familyKind: fx.family,
        parentTicketId: family.parentTicketId,
        nhKind: c.nhKind,
        summary: `${person}: NH ${c.nhKind === 'workstation' ? 'Workstation' : 'Laptop'} ticket linked to the onboarding family (no new child)`,
      };
    }
    return { decision: 'ignored', summary: 'Nothing to do' };
  }

  async _record(workspaceId, { ticket, c, plan, mode, outcome, summary, familyId = null, details = {}, actor = null }) {
    const safeClassification = c ? Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined)) : null;
    const row = await soft(() => prisma.hrLifecycleEvent.create({
      data: {
        workspaceId: Number(workspaceId),
        ticketId: ticket?.id ?? null,
        familyId: familyId ?? plan?.familyId ?? null,
        mode,
        noticeType: c?.type || plan?.noticeType || 'manual',
        subject: ticket?.subject ? String(ticket.subject).slice(0, 500) : null,
        person: c?.person || c?.username || details.person || null,
        decision: plan?.decision || 'none',
        outcome,
        summary: summary ? stripSecrets(summary).slice(0, 4000) : null,
        details: { classification: safeClassification, plan: plan || null, ...details },
        actor: actor || HR_LIFECYCLE_ACTOR.name,
      },
    }));
    logger.info(`HR lifecycle [${mode}] ws ${workspaceId} ticket ${ticket?.id ?? '-'}: ${plan?.decision || 'none'} (${outcome})`);
    return row;
  }

  // ------------------------------------------------------------ live execution

  async execute(ticket, c, plan, settings, tz, { actor = null } = {}) {
    const ws = ticket.workspaceId;
    const out = { warnings: [], created: [], adopted: [] };
    let familyId = plan.familyId || null;
    let outcome = 'done';
    try {
      switch (plan.decision) {
      case 'create_family':
      case 'create_family_after_the_fact':
        familyId = await this._createFamily(ticket, c, plan, tz, out);
        break;
      case 'duplicate_linked':
        await this._attachNotice(familyId, ticket, c, out, `HR sent this notice again. The ${plan.familyKind} is already organised on the parent ticket; no new children were created.`);
        break;
      case 'move_dates':
      case 'office_changed':
        await this._moveFamily(familyId, ticket, c, plan, tz, out);
        break;
      case 'cancel_family':
        await this._cancelFamily(familyId, ticket, c, plan, out);
        break;
      case 'link_nh':
        await this._linkNh(familyId, ticket, c, plan, out);
        break;
      case 'notice_is_ticket':
        await this._handleNotice(ticket, c, plan, tz, out);
        break;
      case 'no_family':
      case 'no_date':
        await this._note(ticket, `<p><strong>Onboarding / Offboarding:</strong> ${esc(plan.summary)}.</p>`, out);
        outcome = 'skipped';
        break;
      default:
        outcome = 'skipped';
      }
    } catch (err) {
      outcome = 'failed';
      out.warnings.push(err.message);
      logger.warn(`HR lifecycle: ${plan.decision} for ticket ${ticket.id} failed: ${err.message}`);
    }
    return this._record(ws, {
      ticket, c, plan, mode: 'live', outcome, familyId,
      summary: plan.summary + (out.warnings.length ? ` — ${out.warnings.length} warning(s)` : ''),
      details: { warnings: out.warnings, created: out.created, ...(out.adopted.length || plan.adopt ? { adopted: out.adopted, organisedBy: actor?.email || actor?.name || null } : {}) },
      actor: actor?.email || actor?.name || null,
    });
  }

  async _createFamily(ticket, c, plan, tz, out) {
    const ws = ticket.workspaceId;
    const family = await prisma.hrLifecycleFamily.create({
      data: {
        workspaceId: ws,
        kind: plan.familyKind,
        parentTicketId: ticket.id,
        personName: String(c.person || c.username || 'Unknown').slice(0, 255),
        personKey: normalizePersonName(c.person || c.username || '') || `ticket-${ticket.id}`,
        employeeId: c.employeeId ? String(c.employeeId) : null,
        office: c.office ? String(c.office).slice(0, 120) : null,
        effectiveDate: plan.effectiveDate ? new Date(`${plan.effectiveDate}T00:00:00Z`) : null,
        afterTheFact: plan.afterTheFact === true,
        status: 'open',
        template: plan.template,
        sourceTicketIds: [ticket.id],
        details: { title: c.title || null, manager: c.manager || null, noticeType: c.type, effectiveImmediately: c.effectiveImmediately === true, ...(plan.adopt ? { organisedLater: true } : {}) },
      },
    });

    // Organise now: a notice somebody already owns (or dated) is left as it is.
    if (!(plan.adopt && ticket.assignedTechId)) await this._assign(ticket, plan.parent.assigneeTechId, out);
    if (!(plan.adopt && ticket.dueBy)) await this._setDue(ticket, plan.parent.dueDate, tz, out);

    const svc = await this._ticketService();
    const links = await this._linkService();
    const body = plainBody(ticket);
    const lines = [];
    for (const child of plan.children) {
      if (child.adoptTicketId) {
        try {
          await prisma.hrLifecycleFamilyMember.create({
            data: { familyId: family.id, workspaceId: ws, ticketId: child.adoptTicketId, role: 'child', templateKey: child.key, title: child.title, dueOffsetDays: child.dueOffsetDays },
          });
          // FreshService's own children are already parent/child there; an NH ticket is not.
          if (plan.familyKind === 'onboarding') await this._link(ticket, { id: child.adoptTicketId, origin: child.adoptOrigin, freshserviceTicketId: null, nativeNumber: null }, out);
          out.adopted.push({ ticketId: child.adoptTicketId, ref: child.adoptRef, key: child.key, title: child.title });
          lines.push(`<li>${esc(child.adoptRef)} — ${esc(child.title)} (already existed${child.adoptClosed ? ', closed' : ''})</li>`);
        } catch (err) {
          out.warnings.push(`${child.title} (${child.adoptRef}) not taken in: ${err.message}`);
        }
        continue;
      }
      const intro = CHILD_INTRO[child.key]?.[plan.familyKind] || `${child.title} for the following ${plan.familyKind === 'onboarding' ? 'new hire' : 'user'}.`;
      const html = [
        `<p>${esc(intro)}</p>`,
        `<p>${esc(c.person || '')}${c.office ? ` — ${esc(c.office)}` : ''}${plan.effectiveDate ? ` — ${plan.familyKind === 'onboarding' ? 'starts' : 'last day'} ${esc(fmtDay(plan.effectiveDate))}` : ''}${plan.afterTheFact ? ' (after the fact)' : ''}</p>`,
        body ? `<p>From the HR notice ${esc(ticketDisplayRef(ticket))}:</p><p>${esc(body).replace(/\n/g, '<br>')}</p>` : '',
      ].join('');
      let groupFields = {};
      if (child.groupId) {
        const g = await soft(() => prisma.group.findFirst({ where: { id: child.groupId, workspaceId: ws }, select: { id: true, origin: true, freshserviceId: true } }));
        if (g?.origin === 'local') groupFields = { internalGroupId: g.id };
        else if (g?.freshserviceId) groupFields = { groupId: String(g.freshserviceId) };
      }
      try {
        const created = await svc.createTicket(ws, {
          subject: child.subject,
          description: html,
          priority: [1, 2, 3, 4].includes(Number(ticket.priority)) ? Number(ticket.priority) : 2,
          ...(ticket.requesterId ? { requesterId: ticket.requesterId } : { requesterEmail: ticket.requester?.email || HR_SENDERS[0] }),
          ...(child.assigneeTechId ? { assignedTechId: child.assigneeTechId } : {}),
          ...groupFields,
          ...(child.dueDate ? { dueBy: dueInstant(child.dueDate, tz) } : {}),
          // Blank default = the normal AI routing. HR never gets an ack per child.
          runAiTriage: !child.assigneeTechId,
          notifyRequester: false,
        }, HR_LIFECYCLE_ACTOR);
        await prisma.hrLifecycleFamilyMember.create({
          data: { familyId: family.id, workspaceId: ws, ticketId: created.id, role: 'child', templateKey: child.key, title: child.title, dueOffsetDays: child.dueOffsetDays },
        });
        try {
          await links.setParent(created.id, ws, { parentTicketId: ticket.id }, HR_LIFECYCLE_ACTOR);
        } catch (err) {
          out.warnings.push(`Linking ${child.title} to the parent failed: ${err.message}`);
        }
        const ref = created.displayRef || ticketDisplayRef(created);
        out.created.push({ ticketId: created.id, ref, key: child.key, title: child.title });
        lines.push(`<li>${esc(ref)} — ${esc(child.title)}${child.dueDate ? `, due ${esc(fmtDay(child.dueDate))}` : ''}</li>`);
      } catch (err) {
        out.warnings.push(`${child.title} child not created: ${err.message}`);
      }
    }
    await this._note(ticket, [
      `<p><strong>${plan.familyKind === 'onboarding' ? 'Onboarding' : 'Offboarding'} organised by Ticket Pulse</strong>${plan.afterTheFact ? ' (after the fact)' : ''}.</p>`,
      lines.length ? `<ul>${lines.join('')}</ul>` : '<p>No children were created — see Onboarding → Activity.</p>',
      '<p>This ticket closes once every child is closed.</p>',
    ].join(''), out);

    // Onboarding: NH automation tickets that arrived before the notice join now.
    // (Organise now has already taken them in as the children themselves.)
    if (plan.familyKind === 'onboarding' && !plan.adopt) await this._adoptEarlyNh(family, ticket, c, out);
    return family.id;
  }

  async _adoptEarlyNh(family, parent, c, out) {
    const tz = await this._timeZone(parent.workspaceId);
    const candidates = await soft(() => prisma.ticket.findMany({
      where: { workspaceId: parent.workspaceId, subject: { startsWith: 'NH ' }, createdAt: { gte: new Date(Date.now() - 30 * 86400e3) }, id: { not: parent.id } },
      select: { id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, description: true, descriptionText: true, status: true, createdAt: true, requester: { select: { email: true } } },
      take: 50,
      orderBy: { id: 'desc' },
    }), []);
    for (const t of candidates) {
      const nc = this.classify(t, tz);
      if (!nc || nc.type !== 'nh_automation') continue;
      const sameId = c.employeeId && nc.employeeId && String(c.employeeId) === String(nc.employeeId);
      const sameName = !c.employeeId && nc.person && normalizePersonName(nc.person) === normalizePersonName(c.person);
      if (!sameId && !sameName) continue;
      if (await this._isTerminal(t.workspaceId, t.status)) continue;
      await this._linkNh(family.id, t, nc, { parentTicketId: parent.id, nhKind: nc.nhKind }, out);
    }
  }

  async _attachNotice(familyId, ticket, c, out, text) {
    const family = await prisma.hrLifecycleFamily.findUnique({ where: { id: familyId } });
    if (!family) throw new NotFoundError('Family not found');
    const parent = family.parentTicketId ? await this._loadTicket(family.parentTicketId, family.workspaceId) : null;
    if (parent && parent.id !== ticket.id) {
      await this._link(parent, ticket, out);
      await this._note(ticket, `<p><strong>Onboarding / Offboarding:</strong> ${esc(text)} Family parent: ${esc(ticketDisplayRef(parent))}.</p>`, out);
    }
    await soft(() => prisma.hrLifecycleFamilyMember.upsert({
      where: { familyId_ticketId: { familyId, ticketId: ticket.id } },
      create: { familyId, workspaceId: family.workspaceId, ticketId: ticket.id, role: 'notice', title: c?.label || 'HR notice' },
      update: {},
    }));
    const ids = Array.isArray(family.sourceTicketIds) ? family.sourceTicketIds : [];
    if (!ids.includes(ticket.id)) {
      await soft(() => prisma.hrLifecycleFamily.update({ where: { id: familyId }, data: { sourceTicketIds: [...ids, ticket.id] } }));
    }
    return { family, parent };
  }

  async _moveFamily(familyId, notice, c, plan, tz, out) {
    const { family } = await this._attachNotice(familyId, notice, c, out, `This change was applied to every open ticket in the ${plan.familyKind} family.`);
    const fam = await this._familyTickets(family);
    const quote = noticeQuote(notice);
    const what = plan.decision === 'office_changed' && !plan.moves.length
      ? `HR changed the office${plan.office ? ` to ${plan.office}` : ''}.`
      : `HR moved the date from ${fmtDay(plan.fromDate)} to ${fmtDay(plan.toDate)}${plan.office ? ` (office: ${plan.office})` : ''}.`;
    const note = (extra = '') => `<p><strong>Onboarding / Offboarding:</strong> ${esc(what)}${extra} Notice ${esc(ticketDisplayRef(notice))}: “${esc(quote)}”</p>`;
    const moveBy = new Map((plan.moves || []).map((m) => [m.ticketId, m]));
    const touched = [];
    if (fam.parent && !fam.parentTerminal) touched.push(fam.parent);
    for (const m of fam.members) if (!m.terminal && m.ticket.id !== notice.id) touched.push(m.ticket);
    for (const t of touched) {
      const mv = moveBy.get(t.id);
      if (mv) await this._setDue(t, mv.dueDate, tz, out);
      await this._note(t, note(mv ? ` Due date now ${fmtDay(mv.dueDate)}.` : ''), out);
    }
    await soft(() => prisma.hrLifecycleFamily.update({
      where: { id: family.id },
      data: {
        ...(plan.toDate ? { effectiveDate: new Date(`${plan.toDate}T00:00:00Z`) } : {}),
        ...(plan.office ? { office: String(plan.office).slice(0, 120) } : {}),
      },
    }));
  }

  async _cancelFamily(familyId, notice, c, plan, out) {
    const { family } = await this._attachNotice(familyId, notice, c, out, `The ${plan.familyKind} was cancelled; the family's open tickets were closed.`);
    const fam = await this._familyTickets(family);
    const quote = noticeQuote(notice);
    const html = `<p><strong>Onboarding / Offboarding — cancelled.</strong> HR: “${esc(quote)}” (notice ${esc(ticketDisplayRef(notice))}). Closed by Ticket Pulse.</p>`;
    // Children first: the parent cannot close while a child is open.
    for (const m of fam.members) {
      if (m.terminal || m.ticket.id === notice.id) continue;
      if (m.member.role === 'child') {
        await this._note(m.ticket, html, out);
        await this._close(m.ticket, out);
      } else if (m.member.role === 'linked') {
        await this._note(m.ticket, `<p><strong>Onboarding / Offboarding — cancelled.</strong> HR: “${esc(quote)}”. This linked ticket was left open for its owner.</p>`, out);
      }
    }
    if (fam.parent && !fam.parentTerminal) {
      await this._note(fam.parent, html, out);
      await this._close(fam.parent, out);
    }
    await prisma.hrLifecycleFamily.update({ where: { id: family.id }, data: { status: 'cancelled', closedAt: new Date() } });
  }

  async _linkNh(familyId, nh, c, plan, out) {
    const family = await prisma.hrLifecycleFamily.findUnique({ where: { id: familyId } });
    if (!family) throw new NotFoundError('Family not found');
    const parent = await this._loadTicket(plan.parentTicketId || family.parentTicketId, family.workspaceId);
    if (!parent) throw new NotFoundError('The family parent ticket is gone');
    await this._link(parent, nh, out);
    await prisma.hrLifecycleFamilyMember.upsert({
      where: { familyId_ticketId: { familyId, ticketId: nh.id } },
      create: { familyId, workspaceId: family.workspaceId, ticketId: nh.id, role: 'linked', templateKey: `nh_${c.nhKind || 'ticket'}`, title: `NH ${c.nhKind === 'workstation' ? 'Workstation' : 'Laptop'} (automation)` },
      update: {},
    });
    const childTitle = c.nhKind === 'workstation' ? 'Workstation' : 'Laptop';
    // Never quote the NH body: it can carry the initial password.
    await this._note(nh, `<p><strong>Onboarding:</strong> part of the onboarding of ${esc(family.personName)} (parent ${esc(ticketDisplayRef(parent))}). The ${esc(childTitle)} child ticket there covers this work — no duplicate child was created.</p>`, out);
    await this._note(parent, `<p><strong>Onboarding:</strong> the automation's ${esc(ticketDisplayRef(nh))} (NH ${esc(childTitle)}) was linked to this family.</p>`, out);
  }

  async _handleNotice(ticket, c, plan, tz, out) {
    const n = plan.notice;
    await this._assign(ticket, n.assigneeTechId, out);
    if (n.dueDate && n.dueDate >= (c.noticeDate || '')) await this._setDue(ticket, n.dueDate, tz, out);
    let parked = null;
    if (n.park && n.dueDate && !ticket.parkedUntil) {
      try {
        const parks = await this._parkService();
        const s = await parks.hrSuggestion(ticket.id, ticket.workspaceId);
        if (s?.usable) {
          await parks.park(ticket.id, ticket.workspaceId, { kind: 'until_date', until: s.until, reason: s.reason }, { name: 'Ticket Pulse (HR notice)', role: 'automation' }, { source: 'suggested_hr' });
          parked = s.wakeDate;
        }
      } catch (err) {
        out.warnings.push(`Park skipped: ${err.message}`);
      }
    }
    await this._note(ticket, `<p><strong>Onboarding / Offboarding:</strong> ${esc(plan.summary)}${parked ? ` — parked until ${esc(fmtDay(parked))}` : ''}.</p>`, out);
  }

  // ------------------------------------------------------------ organise now

  /**
   * Start a family for a notice that arrived before Live (or that the hook
   * missed): tickets that already cover the work are taken in, only the
   * missing children are created. Live only; one family per notice.
   */
  async organise(ticketId, workspaceId, actor = null) {
    const ws = Number(workspaceId);
    if ((await this.getMode(ws)) !== 'live') throw new ConflictError('Switch On/Offboarding to Live first');
    const ticket = await this._loadTicket(ticketId, ws);
    if (!ticket) throw new NotFoundError('Ticket not found in this workspace');
    const tz = await this._timeZone(ws);
    const c = this.classify(ticket, tz);
    if (!c || NOTICE_EFFECT[c.type]?.effect !== 'create') throw new ValidationError('Only a departure or new-hire notice can start a family');
    const key = `${ws}:${ticket.id}`;
    if (this._inFlight.has(key)) throw new ConflictError('This notice is being organised right now');
    this._inFlight.add(key);
    try {
      const already = await soft(() => prisma.hrLifecycleFamily.findFirst({ where: { workspaceId: ws, parentTicketId: ticket.id }, select: { id: true } }));
      if (already) throw new ConflictError('This notice already has a family');
      const settings = await this.getSettings(ws);
      const plan = await this.plan(ticket, c, settings, tz, { adopt: true });
      if (!['create_family', 'create_family_after_the_fact'].includes(plan.decision)) throw new ConflictError(`${plan.summary || 'Nothing to organise'}`);
      const event = await this.execute(ticket, c, plan, settings, tz, { actor });
      return { familyId: event?.familyId ?? null, outcome: event?.outcome || null, summary: event?.summary || plan.summary, warnings: event?.details?.warnings || [] };
    } finally {
      this._inFlight.delete(key);
    }
  }

  /**
   * Open departure / new-hire notices that have no family yet, each with what
   * Organise would do: the tickets it would take in and the ones it would
   * create. Reads only.
   */
  async candidates(workspaceId) {
    const ws = Number(workspaceId);
    const tz = await this._timeZone(ws);
    const rows = await soft(() => prisma.ticket.findMany({
      where: {
        workspaceId: ws,
        createdAt: { gte: new Date(Date.now() - ADOPT_LOOKBACK_DAYS * 86400e3) },
        requester: { email: { in: [...HR_SENDERS] } },
        OR: [{ subject: { startsWith: 'Departure Notification' } }, { subject: { startsWith: 'New Hire' } }],
      },
      select: {
        id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, description: true,
        descriptionText: true, status: true, priority: true, dueBy: true, createdAt: true, assignedTechId: true, requesterId: true, parkedUntil: true,
        requester: { select: { email: true, name: true } }, assignedTech: { select: { id: true, name: true } },
      },
      take: 400,
      orderBy: { id: 'desc' },
    }), []) || [];
    if (!rows.length) return [];
    const families = await soft(() => prisma.hrLifecycleFamily.findMany({
      where: { workspaceId: ws }, select: { parentTicketId: true, kind: true, status: true, personKey: true, employeeId: true }, take: 2000, orderBy: { id: 'desc' },
    }), []) || [];
    const parents = new Set(families.map((f) => f.parentTicketId).filter(Boolean));
    const open = families.filter((f) => f.status === 'open');
    const settings = await this.getSettings(ws);
    const techName = new Map((await this._technicians(ws)).map((t) => [t.id, t.name]));
    let nhTickets = null;
    const seen = new Set();
    const out = [];
    for (const t of rows) {
      if (out.length >= CANDIDATE_LIMIT) break;
      if (parents.has(t.id) || await this._isTerminal(ws, t.status)) continue;
      const c = this.classify(t, tz);
      const fx = c ? NOTICE_EFFECT[c.type] : null;
      if (!fx || fx.effect !== 'create') continue;
      const personKey = normalizePersonName(c.person || '');
      // Newest notice per person and kind (a re-sent notice is the same family).
      const dedupe = `${fx.family}:${c.employeeId || personKey || `t${t.id}`}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (open.some((f) => f.kind === fx.family && ((c.employeeId && f.employeeId === String(c.employeeId)) || (personKey && f.personKey === personKey)))) continue;
      if (fx.family === 'onboarding' && !nhTickets) nhTickets = await this._nhTickets(ws);
      const plan = await this.plan(t, c, settings, tz, { adopt: true, nhTickets });
      if (!['create_family', 'create_family_after_the_fact'].includes(plan.decision)) continue;
      out.push({
        ticketId: t.id,
        kind: fx.family,
        personName: c.person || null,
        office: c.office || null,
        effectiveDate: plan.effectiveDate || null,
        afterTheFact: Boolean(plan.afterTheFact),
        noticeDate: c.noticeDate || null,
        parent: { ...this._ticketCard(t), assignee: t.assignedTech ? { id: t.assignedTech.id, name: t.assignedTech.name, photoUrl: null } : null },
        existing: plan.children.filter((x) => x.adoptTicketId).map((x) => ({ title: x.title, ref: x.adoptRef, status: x.adoptStatus, closed: Boolean(x.adoptClosed) })),
        toCreate: plan.children.filter((x) => !x.adoptTicketId).map((x) => ({ title: x.title, dueDate: x.dueDate || null, assignee: x.assigneeTechId ? techName.get(x.assigneeTechId) || null : null })),
      });
    }
    return out.sort((a, b) => String(a.effectiveDate || '9999').localeCompare(String(b.effectiveDate || '9999')));
  }

  // ------------------------------------------------------------ manual action

  /** One click on the parent: drop the children the after-the-fact list does not have. */
  async switchToAfterTheFact(familyId, workspaceId, actor) {
    const ws = Number(workspaceId);
    const family = await soft(() => prisma.hrLifecycleFamily.findFirst({ where: { id: Number(familyId), workspaceId: ws } }));
    if (!family) throw new NotFoundError('Family not found');
    if (family.kind !== 'offboarding') throw new ValidationError('Only an offboarding family can switch to after the fact');
    if (family.status !== 'open') throw new ConflictError('This family is no longer open');
    if (family.afterTheFact) throw new ConflictError('This family is already after the fact');
    const settings = await this.getSettings(ws);
    const keep = new Set((settings.templates.offboarding_after_fact || []).map((i) => i.key));
    const fam = await this._familyTickets(family);
    const out = { warnings: [], created: [] };
    const who = actor?.name || actor?.email || 'an admin';
    const closed = [];
    const by = { ...HR_LIFECYCLE_ACTOR, name: `${who} via Onboarding` };
    for (const m of fam.members) {
      if (m.member.role !== 'child' || m.terminal || keep.has(m.member.templateKey)) continue;
      try {
        const svc = await this._ticketService();
        await svc.addPrivateNote(m.ticket.id, ws, { bodyHtml: `<p><strong>Switched to after the fact</strong> by ${esc(who)}: the account was handled before the notice, so ${esc(m.member.title || 'this task')} is not needed. Closed by Ticket Pulse.</p>` }, by);
      } catch (err) { out.warnings.push(`Note on ${ticketDisplayRef(m.ticket)} failed: ${err.message}`); }
      if (await this._close(m.ticket, out)) closed.push({ ticketId: m.ticket.id, ref: ticketDisplayRef(m.ticket), title: m.member.title });
    }
    await prisma.hrLifecycleFamily.update({ where: { id: family.id }, data: { afterTheFact: true, template: 'offboarding_after_fact' } });
    if (fam.parent) {
      await this._note(fam.parent, `<p><strong>Switched to after the fact</strong> by ${esc(who)}. Closed: ${closed.length ? esc(closed.map((x) => `${x.ref} (${x.title})`).join(', ')) : 'nothing — no extra children were open'}.</p>`, out);
    }
    await this._record(ws, {
      ticket: fam.parent,
      c: null,
      plan: { decision: 'switch_after_the_fact', familyId: family.id, noticeType: 'manual' },
      mode: 'manual',
      outcome: 'done',
      familyId: family.id,
      summary: `${family.personName}: switched to after the fact by ${who}; closed ${closed.length} ${closed.length === 1 ? 'child' : 'children'}`,
      details: { closed, warnings: out.warnings, person: family.personName },
      actor: actor?.email || who,
    });
    return { familyId: family.id, closed, warnings: out.warnings };
  }

  // ------------------------------------------------------------ reads for the page

  _ticketCard(t) {
    if (!t) return null;
    return {
      id: t.id,
      ref: ticketDisplayRef(t),
      subject: t.subject,
      status: t.status,
      dueBy: t.dueBy || null,
      parkedUntil: t.parkedUntil || null,
      assignee: t.assignedTech ? { id: t.assignedTech.id, name: t.assignedTech.name, photoUrl: t.assignedTech.photoUrl || null } : null,
    };
  }

  async listFamilies(workspaceId, { status = null, kind = null, limit = 100 } = {}) {
    const ws = Number(workspaceId);
    const real = await this._listRealFamilies(ws, { status, kind, limit });
    // 2 Oct 2026 (Vahid: "I don't see anyone under People"): Shadow builds no
    // real families, so People also lists the families Shadow recorded —
    // marked shadow, with the children it would create.
    // Once Live, those people are offered under "Not organised yet" instead.
    const shadow = (await this.getMode(ws)) === 'live' ? [] : await this._shadowFamilies(ws, { status, kind });
    return [...real, ...shadow];
  }

  /**
   * Families Shadow recorded (create_family events), one per person and kind,
   * with what later Shadow notices did to them: linked NH tickets, a moved
   * date, a cancellation. Read-only.
   */
  async _shadowFamilies(workspaceId, { status = null, kind = null } = {}) {
    const ws = Number(workspaceId);
    if (status && !['open', 'cancelled'].includes(status)) return [];
    const events = await soft(() => prisma.hrLifecycleEvent.findMany({
      where: { workspaceId: ws, mode: 'observe', createdAt: { gte: new Date(Date.now() - 180 * 86400e3) } },
      orderBy: { id: 'asc' },
      take: 500,
      select: { id: true, ticketId: true, person: true, decision: true, details: true, createdAt: true },
    }), []);
    const creates = events.filter((e) => ['create_family', 'create_family_after_the_fact'].includes(e.decision) && e.details?.plan?.familyKind);
    if (!creates.length) return [];
    // Newest create per person + kind wins (a re-sent notice is a duplicate).
    const byKey = new Map();
    for (const e of creates) {
      const k = `${e.details.plan.familyKind}:${normalizePersonName(e.person || '') || `t${e.ticketId}`}`;
      byKey.set(k, e);
    }
    const techs = await this._technicians(ws);
    const techName = new Map(techs.map((t) => [t.id, t.name]));
    const parentIds = [...byKey.values()].map((e) => e.ticketId).filter(Boolean);
    const parents = parentIds.length ? await soft(() => prisma.ticket.findMany({
      where: { id: { in: parentIds }, workspaceId: ws },
      select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, status: true, dueBy: true, parkedUntil: true },
    }), []) : [];
    const parentById = new Map(parents.map((t) => [t.id, t]));
    const out = [];
    for (const e of byKey.values()) {
      const plan = e.details.plan;
      const follow = events.filter((x) => x.details?.plan?.shadowOf === e.id);
      const cancelled = follow.some((x) => x.decision === 'cancel_family');
      const moved = [...follow].reverse().find((x) => x.decision === 'move_dates' && x.details?.plan?.toDate);
      const famStatus = cancelled ? 'cancelled' : 'open';
      if (status && status !== famStatus) continue;
      if (kind && plan.familyKind !== kind) continue;
      const shiftDays = moved && plan.effectiveDate ? Math.round((new Date(moved.details.plan.toDate) - new Date(plan.effectiveDate)) / 86400e3) : 0;
      const children = (plan.children || []).map((c) => ({
        title: c.title,
        dueDate: c.dueDate && shiftDays ? addDays(c.dueDate, shiftDays) : (c.dueDate || null),
        assignee: Array.isArray(c.assigneeTechIds) && c.assigneeTechIds.length > 1
          ? c.assigneeTechIds.map((id) => techName.get(id)).filter(Boolean).join(' or ') || null
          : (c.assigneeTechId ? techName.get(c.assigneeTechId) || null : null),
      }));
      out.push({
        id: `shadow-${e.id}`,
        shadow: true,
        kind: plan.familyKind,
        personName: e.person || null,
        employeeId: e.details?.classification?.employeeId || null,
        office: e.details?.classification?.office || null,
        effectiveDate: moved ? moved.details.plan.toDate : (plan.effectiveDate || plan.parent?.dueDate || null),
        afterTheFact: Boolean(plan.afterTheFact),
        status: famStatus,
        template: plan.template || null,
        createdAt: e.createdAt,
        parent: this._ticketCard(parentById.get(e.ticketId) || null),
        parentAssignee: plan.parent?.assigneeTechId ? techName.get(plan.parent.assigneeTechId) || null : null,
        progress: { done: 0, total: children.length },
        linked: follow.filter((x) => x.decision === 'link_nh').length,
        plannedChildren: children,
        dateMoved: Boolean(moved),
      });
    }
    return out.sort((a, b) => String(a.effectiveDate || '').localeCompare(String(b.effectiveDate || '')));
  }

  async _listRealFamilies(workspaceId, { status = null, kind = null, limit = 100 } = {}) {
    const ws = Number(workspaceId);
    const rows = await soft(() => prisma.hrLifecycleFamily.findMany({
      where: { workspaceId: ws, ...(status ? { status } : {}), ...(kind ? { kind } : {}) },
      orderBy: [{ status: 'desc' }, { effectiveDate: 'asc' }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 100, 1), 300),
    }), []);
    const out = [];
    for (const f of rows) {
      const fam = await this._familyTickets(f);
      const children = fam.members.filter((m) => m.member.role === 'child');
      const done = children.filter((m) => m.terminal).length;
      let familyStatus = f.status;
      // A family whose parent and children are all closed is closed.
      if (f.status === 'open' && fam.parent && fam.parentTerminal && done === children.length) {
        familyStatus = 'closed';
        await soft(() => prisma.hrLifecycleFamily.update({ where: { id: f.id }, data: { status: 'closed', closedAt: new Date() } }));
      }
      out.push({
        id: f.id,
        kind: f.kind,
        personName: f.personName,
        employeeId: f.employeeId,
        office: f.office,
        effectiveDate: dateOnly(f.effectiveDate),
        afterTheFact: f.afterTheFact,
        status: familyStatus,
        template: f.template,
        createdAt: f.createdAt,
        parent: this._ticketCard(fam.parent),
        progress: { done, total: children.length },
        linked: fam.members.filter((m) => m.member.role === 'linked').length,
      });
    }
    return out;
  }

  async getFamily(familyId, workspaceId) {
    const ws = Number(workspaceId);
    const f = await soft(() => prisma.hrLifecycleFamily.findFirst({ where: { id: Number(familyId), workspaceId: ws } }));
    if (!f) throw new NotFoundError('Family not found');
    const fam = await this._familyTickets(f);
    const events = await soft(() => prisma.hrLifecycleEvent.findMany({ where: { workspaceId: ws, familyId: f.id }, orderBy: { createdAt: 'desc' }, take: 50 }), []);
    return {
      id: f.id,
      kind: f.kind,
      personName: f.personName,
      employeeId: f.employeeId,
      office: f.office,
      effectiveDate: dateOnly(f.effectiveDate),
      afterTheFact: f.afterTheFact,
      status: f.status,
      template: f.template,
      details: f.details || null,
      createdAt: f.createdAt,
      parent: this._ticketCard(fam.parent),
      members: fam.members.map((m) => ({
        role: m.member.role, key: m.member.templateKey, title: m.member.title, dueOffsetDays: m.member.dueOffsetDays, closed: m.terminal, ticket: this._ticketCard(m.ticket),
      })),
      events,
    };
  }

  async listEvents(workspaceId, { limit = 100, familyId = null } = {}) {
    return soft(() => prisma.hrLifecycleEvent.findMany({
      where: { workspaceId: Number(workspaceId), ...(familyId ? { familyId: Number(familyId) } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    }), []);
  }

  async people(workspaceId) {
    const [technicians, groups] = await Promise.all([this._technicians(workspaceId), this._groups(workspaceId)]);
    return { technicians, groups };
  }
}

const hrLifecycleService = new HrLifecycleService();
export { HrLifecycleService, localDate };
export default hrLifecycleService;
