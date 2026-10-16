import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Workspace coordinators (QA 10-15, item 9): "one or two coordinators or
 * escalation agents, based on their availability, or alerted at the same time"
 * instead of one coordinator per group.
 *
 * Up to three people, in order, and how they are used:
 *   first_available — the first one who is at work owns the ticket and is told;
 *                     nobody at work → the first active one owns it anyway.
 *   all             — everyone on the list is told at once; the first one who
 *                     is at work owns it (the first active one when nobody is).
 * Used whenever a ticket's group has no coordinator (or backup) at work —
 * groupCoordinatorService.pickCoordinator() walks the order.
 *
 * Storage: one app_settings row per workspace, no table —
 *   key   workspace_coordinators_ws<id>
 *   value { "technicianIds": [n, …], "mode": "first_available"|"all", "updatedBy", "updatedAt" }
 * A missing, unreadable or bad row reads as "never saved": the single legacy
 * coordinator column (UrgentResponseSettings.coordinatorTechnicianId) is then
 * the list, so nothing set before is lost. A saved empty list clears that
 * column too, so "nobody" really means nobody.
 */

export const settingsKey = (workspaceId) => `workspace_coordinators_ws${Number(workspaceId)}`;
export const MAX_COORDINATORS = 3;
export const COORDINATOR_MODES = Object.freeze(['first_available', 'all']);
export const DEFAULT_MODE = 'first_available';

const isId = (n) => Number.isInteger(n) && n > 0;
const toId = (v) => (typeof v === 'boolean' || v === null || v === '' ? NaN : Number(v));
const quiet = (fn, fallback) => Promise.resolve().then(fn).catch((err) => {
  logger.debug?.(`Workspace coordinators read degraded: ${err.message}`);
  return fallback;
});

/** The stored JSON → { technicianIds, mode, updatedBy, updatedAt }, or null when never saved / unreadable. */
export function parseStored(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ids = Array.isArray(value.technicianIds) ? value.technicianIds.map(toId).filter(isId) : [];
  return {
    technicianIds: [...new Set(ids)].slice(0, MAX_COORDINATORS),
    mode: COORDINATOR_MODES.includes(value.mode) ? value.mode : DEFAULT_MODE,
    updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

/**
 * Clean and check an input: { value: { technicianIds, mode }, errors: [plain words] }.
 * Repeats are dropped (the first place wins); more than three is refused.
 * `activeIds`: the active technicians of the workspace (a Set), when known.
 */
export function validateCoordinators(input, { activeIds = null } = {}) {
  const errors = [];
  const raw = input?.technicianIds ?? [];
  const list = Array.isArray(raw) ? raw : null;
  if (!list) errors.push('The coordinators must be a list of people');
  const ids = (list || []).map(toId);
  if (ids.some((n) => !isId(n))) errors.push('A coordinator is not valid');
  const technicianIds = [...new Set(ids.filter(isId))];
  if (technicianIds.length > MAX_COORDINATORS) errors.push('Pick at most three coordinators');
  const mode = input?.mode === undefined || input?.mode === null || input?.mode === '' ? DEFAULT_MODE : input.mode;
  if (!COORDINATOR_MODES.includes(mode)) errors.push('Pick how the coordinators are used');
  if (activeIds && !errors.length && technicianIds.some((id) => !activeIds.has(id))) {
    errors.push('Coordinators: pick active technicians of this workspace');
  }
  return { value: { technicianIds, mode }, errors };
}

const sameList = (a, b) => a.mode === b.mode && a.technicianIds.length === b.technicianIds.length && a.technicianIds.every((id, i) => id === b.technicianIds[i]);

class WorkspaceCoordinatorService {
  /** The saved list, or null when never saved. Never throws. */
  async get(workspaceId) {
    const raw = await quiet(() => settingsRepository.get(settingsKey(workspaceId)), null);
    return parseStored(raw);
  }

  /** The legacy single coordinator (Settings → Urgent response, before the list). Never throws. */
  async legacyId(workspaceId) {
    const row = await quiet(() => prisma.urgentResponseSettings.findUnique({
      where: { workspaceId: Number(workspaceId) },
      select: { coordinatorTechnicianId: true },
    }), null);
    return isId(row?.coordinatorTechnicianId) ? row.coordinatorTechnicianId : null;
  }

  /**
   * The list in force: the saved one when it names somebody, else the legacy
   * coordinator as a one-person list. `legacyId` may be passed (the engine has
   * its settings already); undefined reads it.
   * @returns {{ technicianIds: number[], mode, fromLegacy: boolean, saved: boolean, updatedBy, updatedAt }}
   */
  async getEffective(workspaceId, { legacyId } = {}) {
    const stored = await this.get(workspaceId);
    if (stored?.technicianIds.length) return { ...stored, fromLegacy: false, saved: true };
    const legacy = legacyId === undefined ? await this.legacyId(workspaceId) : (isId(Number(legacyId)) ? Number(legacyId) : null);
    return {
      technicianIds: legacy ? [legacy] : [],
      mode: stored?.mode || DEFAULT_MODE,
      fromLegacy: Boolean(legacy),
      saved: Boolean(stored),
      updatedBy: stored?.updatedBy || null,
      updatedAt: stored?.updatedAt || null,
    };
  }

  /**
   * Save the list (admin routes only). People must be active technicians of
   * this workspace; at most three; repeats dropped. One audit line in the log
   * and one row in the urgent-response change history.
   * @returns the getEffective() shape plus `changed`.
   */
  async set(workspaceId, input = {}, actor = null, { now = new Date() } = {}) {
    const ws = Number(workspaceId);
    const first = validateCoordinators(input);
    if (first.errors.length) throw new ValidationError(first.errors[0], first.errors);
    const ids = first.value.technicianIds;
    const active = ids.length ? await prisma.technician.findMany({
      where: { workspaceId: ws, isActive: true, id: { in: ids } },
      select: { id: true },
      take: ids.length,
    }) : [];
    const { value, errors } = validateCoordinators(first.value, { activeIds: new Set(active.map((t) => t.id)) });
    if (errors.length) throw new ValidationError(errors[0], errors);

    const before = await this.getEffective(ws);
    const beforeValue = { technicianIds: before.technicianIds, mode: before.mode };
    if (before.saved && !before.fromLegacy && sameList(beforeValue, value)) return { ...before, changed: false };

    const who = actor?.email || actor?.name || null;
    await settingsRepository.set(settingsKey(ws), JSON.stringify({ ...value, updatedBy: who, updatedAt: now.toISOString() }));
    // An empty list means nobody: the old single coordinator must not come back through the fallback.
    if (!value.technicianIds.length && before.fromLegacy) {
      await prisma.urgentResponseSettings.updateMany({ where: { workspaceId: ws }, data: { coordinatorTechnicianId: null } });
    }
    await quiet(() => prisma.urgentResponseSettingsChange.create({
      data: {
        workspaceId: ws, changedBy: actor?.email || null, changedByName: actor?.name || null, field: 'coordinators', before: beforeValue, after: value,
      },
    }), null);
    logger.info(`Workspace coordinators ws ${ws} changed by ${who || 'unknown'}: [${beforeValue.technicianIds.join(', ') || 'none'}] ${beforeValue.mode} → [${value.technicianIds.join(', ') || 'none'}] ${value.mode}`, {
      workspaceId: ws, by: who, before: beforeValue, after: value,
    });
    return {
      ...value, fromLegacy: false, saved: true, updatedBy: who, updatedAt: now.toISOString(), changed: true,
    };
  }
}

const workspaceCoordinatorService = new WorkspaceCoordinatorService();
export default workspaceCoordinatorService;
export { WorkspaceCoordinatorService };
