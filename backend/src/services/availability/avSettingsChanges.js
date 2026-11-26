/**
 * Vacation Pulse settings history (26 Nov 2026): one av_settings_changes row
 * for every change to leave types, their per-workspace switches, rules,
 * offices, approval groups (members and approvers included), people and the
 * general settings, the Vacation Tracker retirement too. Who, when, what,
 * before and after.
 *
 * Recording never blocks a save: any failure is a warning in the log.
 */
import prisma from '../prisma.js';
import logger from '../../utils/logger.js';

export const PAGE_SIZE = 50;

const lc = (s) => String(s || '').trim().toLowerCase();

/** JSON-safe copy (Dates as ISO strings, Decimals as numbers). */
function plain(v) {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && typeof x.toNumber === 'function' ? x.toNumber() : x)));
  } catch {
    return null;
  }
}

const same = (a, b) => JSON.stringify(plain(a) ?? null) === JSON.stringify(plain(b) ?? null);

/**
 * Only the fields that changed: { before, after }, or null when nothing did.
 * `fields` limits the comparison (default: every key of `after`).
 */
export function changedFields(before, after, fields = null) {
  const keys = fields || Object.keys(after || {});
  const b = {};
  const a = {};
  for (const k of keys) {
    const was = before ? before[k] : undefined;
    const now = after ? after[k] : undefined;
    if (now === undefined) continue;
    if (same(was, now)) continue;
    b[k] = plain(was);
    a[k] = plain(now);
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

/**
 * Write one history row. Never throws.
 * { actor, workspaceId, entity, entityId, action, before, after }
 */
export async function recordChange({ actor, workspaceId = null, entity, entityId = null, action, before = null, after = null }) {
  try {
    await prisma.avSettingsChange.create({
      data: {
        actor: lc(typeof actor === 'string' ? actor : actor?.email) || 'unknown',
        workspaceId: Number.isInteger(Number(workspaceId)) && workspaceId !== null ? Number(workspaceId) : null,
        entity: String(entity),
        entityId: entityId === null || entityId === undefined ? null : String(entityId),
        action: String(action),
        before: before === null ? undefined : plain(before),
        after: after === null ? undefined : plain(after),
      },
    });
    return true;
  } catch (err) {
    logger.warn(`Vacation Pulse: could not record a settings change (${entity} ${action}${entityId ? ` ${entityId}` : ''}): ${err.message}`);
    return false;
  }
}
