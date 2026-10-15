import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { awayPhrase, groupPossessive } from './urgentResponse/rules.js';

/**
 * Group coordinators (QA 10-14, "Who is the coordinator?").
 *
 * Every group (FreshService or internal) can name a coordinator and a backup.
 * Urgent response asks resolveCoordinator() who "the coordinator" is for a
 * ticket: the group's coordinator when they are at work, else the group's
 * backup when they are at work, else the workspace coordinator (Settings →
 * Urgent response → Rules), else nobody.
 *
 * Storage: one app_settings row per workspace, no table —
 *   key   group_coordinators_ws<id>
 *   value { "<groupId>": { "coordinatorTechnicianId": n|null, "backupTechnicianId": n|null, "updatedBy", "updatedAt" } }
 * A missing row, an unreadable row or bad JSON reads as "none set".
 * Every save writes one audit line to the log (who, group, before → after).
 */

export const settingsKey = (workspaceId) => `group_coordinators_ws${Number(workspaceId)}`;

const MAX_GROUPS = 1000;
const isId = (n) => Number.isInteger(n) && n > 0;
const idOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'boolean' ? NaN : Number(v);
  return isId(n) ? n : NaN;
};
const firstName = (name) => String(name || '').trim().split(' ')[0] || 'They';

/** One entry, tolerant of anything: ids or null, nothing else. */
function cleanEntry(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v) => {
    const n = idOrNull(v);
    return Number.isNaN(n) ? null : n;
  };
  return {
    coordinatorTechnicianId: pick(src.coordinatorTechnicianId),
    backupTechnicianId: pick(src.backupTechnicianId),
    updatedBy: typeof src.updatedBy === 'string' ? src.updatedBy : null,
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : null,
  };
}

/** The stored JSON → { groupId: entry } with only valid group ids and entries that name somebody. */
export function parseStored(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const groupId = Number(key);
    if (!isId(groupId)) continue;
    const clean = cleanEntry(entry);
    if (clean.coordinatorTechnicianId || clean.backupTechnicianId) out[String(groupId)] = clean;
  }
  return out;
}

/**
 * What is wrong with an entry, in plain words (empty = it can be saved).
 * `activeIds`: the active technicians of the workspace (a Set of ids).
 */
export function validateEntry(input, { activeIds = null } = {}) {
  const errors = [];
  const coordinator = idOrNull(input?.coordinatorTechnicianId);
  const backup = idOrNull(input?.backupTechnicianId);
  if (Number.isNaN(coordinator)) errors.push('The coordinator is not valid');
  if (Number.isNaN(backup)) errors.push('The backup is not valid');
  if (errors.length) return errors;
  if (backup && !coordinator) errors.push('Pick a coordinator before a backup');
  if (coordinator && backup && coordinator === backup) errors.push('The backup must be a different person from the coordinator');
  if (activeIds) {
    if (coordinator && !activeIds.has(coordinator)) errors.push('Coordinator: pick an active technician of this workspace');
    if (backup && !activeIds.has(backup)) errors.push('Backup: pick an active technician of this workspace');
  }
  return errors;
}

/**
 * The order, with nothing read: group coordinator at work → group backup at
 * work → workspace coordinator (active) → nobody.
 *
 * @param {{ entry, group, coordinator, coordinatorState, backup, backupState, workspaceCoordinator }} input
 *   people are technician rows ({ id, name, isActive }) or null; states are rules.atWork() results.
 * @returns {{ technicianId: number|null, name: string|null, source: 'group'|'group_backup'|'workspace'|null,
 *   reason: string, awayNote: string|null, groupId: number|null, groupName: string|null }}
 *   `awayNote`: why the people before the one used were passed over ("Priya is on leave"), for the sentence.
 */
export function pickCoordinator({
  entry = null, group = null, coordinator = null, coordinatorState = null, backup = null, backupState = null, workspaceCoordinator = null,
} = {}) {
  const groupId = group?.id ?? null;
  const groupName = group?.name ?? null;
  const base = { groupId, groupName };
  const usable = (person, state) => Boolean(person && person.isActive !== false && state?.atWork);
  // Somebody passed over is never "at work" in the sentence, whatever their state says.
  const awayState = (person, state) => (person && person.isActive !== false && state && !state.atWork ? state : { atWork: false, reason: 'inactive' });
  const where = groupPossessive(groupName);
  const passed = [];
  const reasons = [];

  if (entry?.coordinatorTechnicianId) {
    if (usable(coordinator, coordinatorState)) {
      return {
        ...base, technicianId: coordinator.id, name: coordinator.name || null, source: 'group', awayNote: null,
        reason: `${coordinator.name} is ${where} coordinator and is at work`,
      };
    }
    const name = coordinator?.name || `Technician ${entry.coordinatorTechnicianId}`;
    passed.push({ name, state: awayState(coordinator, coordinatorState) });
    reasons.push(`${where} coordinator ${name} is not at work`);
  }
  if (entry?.backupTechnicianId) {
    if (usable(backup, backupState)) {
      const awayNote = passed.length ? awayPhrase(passed[0].name, passed[0].state) : null;
      return {
        ...base, technicianId: backup.id, name: backup.name || null, source: 'group_backup', awayNote,
        reason: `${[...reasons, `${backup.name} is ${where} backup and is at work`].join('; ')}`,
      };
    }
    const name = backup?.name || `Technician ${entry.backupTechnicianId}`;
    passed.push({ name, state: awayState(backup, backupState) });
    reasons.push(`${where} backup ${name} is not at work`);
  }

  let awayNote = null;
  if (passed.length === 1) awayNote = awayPhrase(passed[0].name, passed[0].state);
  if (passed.length === 2) awayNote = `${firstName(passed[0].name)} and ${firstName(passed[1].name)} are away`;
  if (!passed.length && groupId) reasons.push(`${where} coordinator is not set`);
  if (!groupId) reasons.push('the ticket has no group');

  if (workspaceCoordinator && workspaceCoordinator.isActive !== false) {
    return {
      ...base, technicianId: workspaceCoordinator.id, name: workspaceCoordinator.name || null, source: 'workspace', awayNote,
      reason: `${reasons.join('; ')}; the workspace coordinator ${workspaceCoordinator.name} is used`,
    };
  }
  return {
    ...base, technicianId: null, name: null, source: null, awayNote,
    reason: `${reasons.join('; ')}; ${workspaceCoordinator ? 'the workspace coordinator is not active' : 'no workspace coordinator is set'}`,
  };
}

class GroupCoordinatorService {
  /** { groupId: entry } for a workspace. Never throws: a missing or unreadable row is "none set". */
  async getAll(workspaceId) {
    try {
      const raw = await settingsRepository.get(settingsKey(workspaceId));
      return parseStored(raw);
    } catch (err) {
      logger.debug?.(`Group coordinators unreadable for workspace ${workspaceId}: ${err.message}`);
      return {};
    }
  }

  /** The entry of one group: { coordinatorTechnicianId, backupTechnicianId } (nulls when none). */
  async getForGroup(workspaceId, groupId) {
    const all = await this.getAll(workspaceId);
    const entry = all[String(Number(groupId))];
    return entry ? { ...entry } : { coordinatorTechnicianId: null, backupTechnicianId: null, updatedBy: null, updatedAt: null };
  }

  /**
   * Set (or clear, with both null) a group's coordinator and backup. Admin
   * routes only. The group must be of this workspace; the people must be its
   * active technicians; coordinator ≠ backup; no backup without a coordinator.
   * @returns {{ groupId, coordinatorTechnicianId, backupTechnicianId, changed: boolean }}
   */
  async setForGroup(workspaceId, groupId, input = {}, actor = null, { now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const gid = Number(groupId);
    if (!isId(gid)) throw new ValidationError('That group id is not valid');
    const group = await prisma.group.findFirst({ where: { id: gid, workspaceId: ws }, select: { id: true, name: true } });
    if (!group) throw new NotFoundError('Group not found in this workspace');

    const named = [idOrNull(input?.coordinatorTechnicianId), idOrNull(input?.backupTechnicianId)].filter((n) => isId(n));
    const active = named.length ? await prisma.technician.findMany({
      where: { workspaceId: ws, isActive: true, id: { in: named } },
      select: { id: true },
      take: named.length,
    }) : [];
    const errors = validateEntry(input, { activeIds: new Set(active.map((t) => t.id)) });
    if (errors.length) throw new ValidationError(errors[0], errors);

    const coordinatorTechnicianId = idOrNull(input?.coordinatorTechnicianId);
    const backupTechnicianId = idOrNull(input?.backupTechnicianId);
    const all = await this.getAll(ws);
    const before = all[String(gid)] || { coordinatorTechnicianId: null, backupTechnicianId: null };
    const changed = before.coordinatorTechnicianId !== coordinatorTechnicianId || before.backupTechnicianId !== backupTechnicianId;
    if (!changed) return { groupId: gid, coordinatorTechnicianId, backupTechnicianId, changed: false };

    const who = actor?.email || actor?.name || null;
    const next = { ...all };
    if (!coordinatorTechnicianId && !backupTechnicianId) delete next[String(gid)];
    else next[String(gid)] = { coordinatorTechnicianId, backupTechnicianId, updatedBy: who, updatedAt: now.toISOString() };
    await settingsRepository.set(settingsKey(ws), JSON.stringify(next));
    logger.info(`Group coordinators ws ${ws} changed by ${who || 'unknown'}: group ${gid} (${group.name}) coordinator ${before.coordinatorTechnicianId ?? 'none'} → ${coordinatorTechnicianId ?? 'none'}, backup ${before.backupTechnicianId ?? 'none'} → ${backupTechnicianId ?? 'none'}`, {
      workspaceId: ws, groupId: gid, by: who, before: { coordinatorTechnicianId: before.coordinatorTechnicianId, backupTechnicianId: before.backupTechnicianId }, after: { coordinatorTechnicianId, backupTechnicianId },
    });
    return { groupId: gid, coordinatorTechnicianId, backupTechnicianId, changed: true };
  }

  /**
   * The groups that have somebody set, with names, for the pages:
   * [{ groupId, groupName, groupActive, coordinator: { id, name, isActive }|null, backup: …|null }], by group name.
   * Entries of groups that are gone are left out. Never throws.
   */
  async listWithNames(workspaceId) {
    const ws = Number(workspaceId);
    const all = await this.getAll(ws);
    const groupIds = Object.keys(all).map(Number).slice(0, MAX_GROUPS);
    if (!groupIds.length) return [];
    try {
      const groups = await prisma.group.findMany({ where: { workspaceId: ws, id: { in: groupIds } }, select: { id: true, name: true, isActive: true }, take: groupIds.length });
      const techIds = [...new Set(groupIds.flatMap((g) => [all[String(g)].coordinatorTechnicianId, all[String(g)].backupTechnicianId]).filter(isId))];
      const techs = techIds.length ? await prisma.technician.findMany({ where: { workspaceId: ws, id: { in: techIds } }, select: { id: true, name: true, isActive: true }, take: techIds.length }) : [];
      const techById = new Map(techs.map((t) => [t.id, t]));
      const person = (id) => (id ? (techById.get(id) ? { id, name: techById.get(id).name, isActive: techById.get(id).isActive !== false } : { id, name: `Technician ${id}`, isActive: false }) : null);
      return groups
        .map((g) => ({
          groupId: g.id,
          groupName: g.name,
          groupActive: g.isActive !== false,
          coordinator: person(all[String(g.id)].coordinatorTechnicianId),
          backup: person(all[String(g.id)].backupTechnicianId),
        }))
        .sort((a, b) => String(a.groupName).localeCompare(String(b.groupName)));
    } catch (err) {
      logger.debug?.(`Group coordinators: names could not be read for workspace ${ws}: ${err.message}`);
      return [];
    }
  }

  /**
   * Who is the coordinator for a group at an instant?
   *
   * "At work" is Urgent response's own rule (shift, business days, approved
   * leave — rules.atWork() through the engine). The engine passes its pass
   * context; any other caller gets one built for `at`.
   *
   * @param {{ workspaceId: number, groupId: number|null, at?: Date,
   *   personOf?: (id) => Promise<object|null>, stateOf?: (person) => object, workspaceCoordinatorId?: number|null,
   *   group?: { id, name }|null, entries?: object }} input
   * @returns the pickCoordinator() result. Never throws (an error reads as "nobody").
   */
  async resolveCoordinator({
    workspaceId, groupId = null, at = new Date(), personOf = null, stateOf = null, workspaceCoordinatorId, group = undefined, entries = null,
  } = {}) {
    const ws = Number(workspaceId);
    try {
      let person = personOf;
      let state = stateOf;
      let wsCoordinatorId = workspaceCoordinatorId;
      if (!person || !state || wsCoordinatorId === undefined) {
        const { default: engine } = await import('./urgentResponse/urgentResponseService.js');
        const ctx = await engine._context(ws, at);
        person = person || ((id) => engine._person(ctx, id));
        state = state || ((p) => engine._state(ctx, p, at));
        if (wsCoordinatorId === undefined) wsCoordinatorId = ctx.settings?.coordinatorTechnicianId ?? null;
      }
      const gid = isId(Number(groupId)) ? Number(groupId) : null;
      let theGroup = group;
      if (theGroup === undefined) {
        theGroup = gid ? await prisma.group.findFirst({ where: { id: gid, workspaceId: ws }, select: { id: true, name: true } }).catch(() => null) : null;
      }
      const all = entries || (gid ? await this.getAll(ws) : {});
      const entry = gid ? all[String(gid)] || null : null;
      const coordinator = entry?.coordinatorTechnicianId ? await person(entry.coordinatorTechnicianId) : null;
      const backup = entry?.backupTechnicianId ? await person(entry.backupTechnicianId) : null;
      const workspaceCoordinator = wsCoordinatorId ? await person(wsCoordinatorId) : null;
      return pickCoordinator({
        entry,
        group: theGroup ? { id: theGroup.id, name: theGroup.name } : (gid ? { id: gid, name: null } : null),
        coordinator,
        coordinatorState: coordinator ? state(coordinator) : null,
        backup,
        backupState: backup ? state(backup) : null,
        workspaceCoordinator,
      });
    } catch (err) {
      logger.warn(`Group coordinators: resolving failed for workspace ${ws}, group ${groupId}: ${err.message}`);
      return { technicianId: null, name: null, source: null, reason: 'could not be worked out', awayNote: null, groupId: groupId ?? null, groupName: null };
    }
  }
}

const groupCoordinatorService = new GroupCoordinatorService();
export default groupCoordinatorService;
export { GroupCoordinatorService };
