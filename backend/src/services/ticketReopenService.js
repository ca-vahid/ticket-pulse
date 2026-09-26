import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';

/**
 * "Re-opened" state (QA 09-25 #1): a ticket that was Resolved/Closed and came
 * back to an Open/Pending base status — and STAYED there.
 *
 * Why "stayed": in IT, 850 of 1,068 terminal→non-terminal moves over 90 days
 * were FreshService "System" automation flipping Closed→Open→Closed inside
 * ~30 seconds (e.g. FS #240246: 23:33:49 Closed→Open, 23:34:15 Open→Closed).
 * Those are not reopens anyone should see. The rule, used live AND by the
 * backfill (scripts/backfill-reopened.mjs) so both agree:
 *
 *   a terminal→open move counts, unless the ticket returns to a terminal
 *   status within REOPEN_FLIP_WINDOW_MS (10 min) of it.
 *
 * Live: stampReopen() counts the move immediately (reopenedAt = now,
 * reopenCount + 1); noteTerminal() undoes it when the close lands inside the
 * window. Times are OBSERVATION times (like the status_changed audit rows the
 * backfill reads), not FreshService's updated_at.
 *
 * Undo and the previous reopenedAt (documented choice): after an undo the
 * count drops by one (never below 0). If it is still > 0, reopenedAt is
 * restored best-effort from the ticket's status_changed history (the latest
 * stuck reopen strictly before the flipped one, same rule); when the history
 * can't produce one it stays null — the column then shows "2×" without an age
 * and the queue State never claims "Re-opened" on a guess.
 *
 * Every entry point swallows its own errors: a status change must never fail
 * because this bookkeeping did.
 */

export const REOPEN_FLIP_WINDOW_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['Resolved', 'Closed']);
const OPEN_LIKE = new Set(['Open', 'Pending']);
// Clock skew between app instances: a close observed a hair "before" the
// reopen it follows still counts as inside the window.
const SKEW_MS = 60 * 1000;
const HISTORY_LOOKBACK_MS = 3 * 365 * 86400e3;

function toMs(value) {
  if (value === null || value === undefined) return NaN;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? NaN : ms;
}

/** 'reopen' | 'terminal' | null for a pair of BASE statuses (Deleted/Spam → null bases → null). */
export function classifyTransition(fromBase, toBase) {
  if (!toBase || fromBase === toBase) return null;
  if (TERMINAL.has(fromBase) && OPEN_LIKE.has(toBase)) return 'reopen';
  if (TERMINAL.has(toBase) && !TERMINAL.has(fromBase)) return 'terminal';
  return null;
}

/**
 * Pure: replay base-status transitions and apply the flip rule.
 * transitions: [{ at, fromBase, toBase }] in any order.
 * Returns { reopenCount, reopenedAt } — reopenedAt is the LAST stuck reopen (Date|null).
 */
export function computeReopenHistory(transitions, { windowMs = REOPEN_FLIP_WINDOW_MS } = {}) {
  const sorted = (transitions || [])
    .map((t) => ({ ...t, ms: toMs(t.at) }))
    .filter((t) => Number.isFinite(t.ms))
    .sort((a, b) => a.ms - b.ms);
  let count = 0;
  let lastMs = null;
  let pending = null; // ms of a reopen whose fate is not yet known
  const commit = () => { count += 1; lastMs = pending; pending = null; };
  for (const t of sorted) {
    const kind = classifyTransition(t.fromBase, t.toBase);
    if (kind === 'reopen') {
      // Two reopens with no observed close between them: the first stuck.
      if (pending !== null) commit();
      pending = t.ms;
    } else if (kind === 'terminal' && pending !== null) {
      if (t.ms - pending <= windowMs) pending = null; // automation flip — never counted
      else commit();
    }
  }
  if (pending !== null) commit();
  return { reopenCount: count, reopenedAt: lastMs === null ? null : new Date(lastMs) };
}

/**
 * Pure (backfill): status_changed activity rows → per-ticket target values.
 * rows: [{ ticketId, performedAt, details: { oldStatus, newStatus } }].
 * baseOf(ticketId, statusName) → base status or null.
 * Returns Map<ticketId, { reopenCount, reopenedAt }>.
 */
export function planReopenBackfill(rows, baseOf, opts = {}) {
  const byTicket = new Map();
  for (const r of rows || []) {
    const oldStatus = r?.details?.oldStatus;
    const newStatus = r?.details?.newStatus;
    if (!oldStatus || !newStatus || oldStatus === newStatus) continue;
    const list = byTicket.get(r.ticketId) || [];
    list.push({ at: r.performedAt, fromBase: baseOf(r.ticketId, oldStatus), toBase: baseOf(r.ticketId, newStatus) });
    byTicket.set(r.ticketId, list);
  }
  const out = new Map();
  for (const [ticketId, list] of byTicket) out.set(ticketId, computeReopenHistory(list, opts));
  return out;
}

/**
 * Backfill write (review S4): raw, parameterized UPDATE so tickets.updated_at
 * (Prisma @updatedAt) is untouched - a history repair must not make every
 * ticket look freshly edited. `client` is a PrismaClient; returns rows sent.
 */
export const REOPEN_BACKFILL_SQL = 'UPDATE tickets SET reopened_at = $1, reopen_count = $2 WHERE id = $3';

export async function applyReopenBackfillBatch(client, batch = []) {
  if (!Array.isArray(batch) || batch.length === 0) return 0;
  await client.$transaction(batch.map((u) => client.$executeRawUnsafe(
    REOPEN_BACKFILL_SQL,
    u.reopenedAt ? new Date(u.reopenedAt) : null,
    Number(u.reopenCount) || 0,
    Number(u.id),
  )));
  return batch.length;
}

/** Count a terminal→open move now. */
export async function stampReopen(ticketId, at = new Date()) {
  try {
    await prisma.ticket.update({
      where: { id: Number(ticketId) },
      data: { reopenedAt: new Date(at), reopenCount: { increment: 1 } },
    });
    return true;
  } catch (err) {
    logger.warn(`reopen stamp skipped for ticket ${ticketId}: ${err.message}`);
    return false;
  }
}

async function previousStuckReopen(ticketId, workspaceId, beforeMs) {
  const rows = await prisma.ticketActivity.findMany({
    where: {
      ticketId: Number(ticketId),
      activityType: 'status_changed',
      // beforeMs = the close minus the window: the flipped reopen sits after
      // it (that is what made it a flip), every earlier stuck one before it.
      performedAt: { gte: new Date(beforeMs - HISTORY_LOOKBACK_MS), lt: new Date(beforeMs) },
    },
    orderBy: { performedAt: 'asc' },
    select: { performedAt: true, details: true },
    take: 1000,
  });
  const names = new Set();
  for (const r of rows) {
    if (r.details?.oldStatus) names.add(String(r.details.oldStatus));
    if (r.details?.newStatus) names.add(String(r.details.newStatus));
  }
  const bases = new Map();
  for (const n of names) bases.set(n, await statusService.resolveBaseStatus(workspaceId, n).catch(() => null));
  return computeReopenHistory(rows.map((r) => ({
    at: r.performedAt,
    fromBase: bases.get(String(r.details?.oldStatus)) ?? null,
    toBase: bases.get(String(r.details?.newStatus)) ?? null,
  }))).reopenedAt;
}

/**
 * A move INTO Resolved/Closed: if it lands within the flip window of the
 * stamped reopen, that reopen never happened (automation echo) — undo it.
 */
export async function noteTerminal(ticketId, at = new Date(), { workspaceId = null } = {}) {
  try {
    const atMs = toMs(at);
    if (!Number.isFinite(atMs)) return false;
    const undone = await prisma.ticket.updateMany({
      where: {
        id: Number(ticketId),
        reopenCount: { gt: 0 },
        reopenedAt: { gte: new Date(atMs - REOPEN_FLIP_WINDOW_MS), lte: new Date(atMs + SKEW_MS) },
      },
      data: { reopenCount: { decrement: 1 }, reopenedAt: null },
    });
    if (!undone?.count) return false;
    // Still counted from earlier stuck reopens? Put the latest one back.
    try {
      const prev = await previousStuckReopen(ticketId, workspaceId, atMs - REOPEN_FLIP_WINDOW_MS);
      if (prev) {
        await prisma.ticket.updateMany({
          where: { id: Number(ticketId), reopenedAt: null, reopenCount: { gt: 0 } },
          data: { reopenedAt: prev },
        });
      }
    } catch (err) {
      logger.debug?.(`previous reopen restore skipped for ticket ${ticketId}: ${err.message}`);
    }
    return true;
  } catch (err) {
    logger.warn(`reopen undo check skipped for ticket ${ticketId}: ${err.message}`);
    return false;
  }
}

/**
 * Single entry for status writers: resolves both labels to their workspace
 * BASE (custom statuses included) and stamps or undoes. Never throws.
 * Returns 'reopen' | 'terminal' | null (what it acted on).
 */
export async function observeStatusTransition({ ticketId, workspaceId, from, to, at = new Date() } = {}) {
  try {
    const fromName = String(from ?? '').trim();
    const toName = String(to ?? '').trim();
    if (!ticketId || !fromName || !toName || fromName === toName) return null;
    const [fromBase, toBase] = await Promise.all([
      statusService.resolveBaseStatus(workspaceId, fromName),
      statusService.resolveBaseStatus(workspaceId, toName),
    ]);
    const kind = classifyTransition(fromBase, toBase);
    if (kind === 'reopen') await stampReopen(ticketId, at);
    else if (kind === 'terminal') await noteTerminal(ticketId, at, { workspaceId });
    return kind;
  } catch (err) {
    logger.warn(`reopen bookkeeping skipped for ticket ${ticketId}: ${err.message}`);
    return null;
  }
}

export default {
  REOPEN_FLIP_WINDOW_MS,
  classifyTransition,
  computeReopenHistory,
  planReopenBackfill,
  applyReopenBackfillBatch,
  stampReopen,
  noteTerminal,
  observeStatusTransition,
};
