import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import statusService from './statusService.js';
import { TICKET_ORIGIN, ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Close resolved tickets (Vahid, 17 Oct 2026). Ticket Pulse closes its own
 * resolved tickets after a set time instead of waiting for FreshService's
 * supervisor rule to close the copy — that rule goes away with the move off
 * FreshService, and until now nothing in Ticket Pulse ever closed a ticket
 * on its own (55 IT tickets had sat Resolved since September).
 *
 * Per workspace, Settings → Ticket Ops → When a ticket is resolved:
 *   enabled     on / off (off everywhere until an admin saves it on)
 *   afterHours  how long a ticket stays Resolved first (AFTER_HOURS_CHOICES)
 *
 * Ticket Pulse tickets only: a FreshService ticket's status belongs to
 * FreshService. The close goes through ticketService.changeStatus, so it is
 * audited, mirrored to the FreshService copy and announced exactly like a
 * person's close (the "Ticket resolved or closed" workflows see it too). A
 * requester reply before the time is up reopens the ticket as usual, which
 * clears resolvedAt, so it is not closed.
 *
 * Storage: one workspace-scoped key in app_settings (no migration), read
 * through a short cache; a settings read that fails counts as OFF, so a
 * hiccup never closes anything.
 */
export const AFTER_HOURS_CHOICES = Object.freeze([1, 4, 24, 48, 72, 168]);
export const DEFAULT_AFTER_HOURS = 48;
export const ACTOR = Object.freeze({ email: 'autoclose@ticketpulse.internal', name: 'Ticket Pulse (closed after resolving)', role: 'system', technicianId: null });

const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SWEEP_INTERVAL_MS = Number(process.env.AUTO_CLOSE_RESOLVED_INTERVAL_MS) || 5 * 60 * 1000;
// Per workspace per pass. A backlog drains over a few passes, so the
// FreshService copies are written a few at a time, never all at once.
const SWEEP_BATCH = 25;
// A ticket that cannot close (a parent with an open child) is left alone this long.
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }

export const settingKey = (workspaceId) => `auto_close_resolved_ws${Number(workspaceId) || 0}`;

export function defaultSettings() {
  return { enabled: false, afterHours: DEFAULT_AFTER_HOURS, changedBy: null, changedAt: null };
}

export function parseSettings(raw) {
  const out = defaultSettings();
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return out; }
  }
  if (!obj || typeof obj !== 'object') return out;
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (AFTER_HOURS_CHOICES.includes(Number(obj.afterHours))) out.afterHours = Number(obj.afterHours);
  if (typeof obj.changedBy === 'string') out.changedBy = obj.changedBy.slice(0, 255);
  if (typeof obj.changedAt === 'string') out.changedAt = obj.changedAt;
  return out;
}

/** "2 days", "1 hour", "1 week" — the words the page and the history use. */
export function afterLabel(hours) {
  const h = Number(hours);
  if (h % 168 === 0) return h === 168 ? '1 week' : `${h / 168} weeks`;
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`;
  return h === 1 ? '1 hour' : `${h} hours`;
}

class AutoCloseResolvedService {
  constructor() {
    this._timer = null;
    this._running = false;
    this._failedAt = new Map(); // ticketId -> ms of the last failed close
  }

  async getSettings(workspaceId) {
    const id = Number(workspaceId);
    if (!Number.isFinite(id) || id <= 0) return defaultSettings();
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value };
    let value;
    try {
      value = parseSettings(await settingsRepository.get(settingKey(id)));
    } catch (err) {
      logger.warn(`autoCloseResolved: settings read failed for workspace ${id} (treating as off): ${err.message}`);
      return defaultSettings(); // not cached: the next read tries again
    }
    cache.set(id, { value, at: Date.now() });
    return { ...value };
  }

  /** Save { enabled?, afterHours? }; anything else is ignored. */
  async setSettings(workspaceId, patch = {}, actor = null) {
    const id = Number(workspaceId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
    let current;
    try {
      current = parseSettings(await settingsRepository.get(settingKey(id)));
    } catch {
      current = defaultSettings();
    }
    const next = { ...current };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.afterHours !== undefined) {
      if (!AFTER_HOURS_CHOICES.includes(Number(patch.afterHours))) {
        throw new Error(`Choose one of ${AFTER_HOURS_CHOICES.map(afterLabel).join(', ')}`);
      }
      next.afterHours = Number(patch.afterHours);
    }
    next.changedBy = actor?.email || actor?.name || null;
    next.changedAt = new Date().toISOString();
    await settingsRepository.set(settingKey(id), JSON.stringify(next));
    cache.set(id, { value: next, at: Date.now() });
    return { ...next };
  }

  /** The Resolved-base status names and the Closed status to move to. */
  async _statuses(workspaceId) {
    const resolved = await statusService.statusNamesForBase(workspaceId, ['Resolved']);
    const closed = await statusService.statusNamesForBase(workspaceId, ['Closed']);
    const closedName = closed.find((n) => n.toLowerCase() === 'closed') || closed[0] || 'Closed';
    return { resolved, closedName };
  }

  _dueWhere(workspaceId, resolvedNames, afterHours, now) {
    const cutoff = new Date(now.getTime() - afterHours * 3600e3);
    return {
      workspaceId,
      origin: TICKET_ORIGIN.TICKETPULSE,
      status: { in: resolvedNames },
      OR: [{ resolvedAt: { lte: cutoff } }, { resolvedAt: null, updatedAt: { lte: cutoff } }],
    };
  }

  /** What the settings page shows: the saved choice and how many tickets are due now. */
  async pageContext(workspaceId, now = new Date()) {
    const settings = await this.getSettings(workspaceId);
    const { resolved } = await this._statuses(workspaceId);
    const count = async (hours) => prisma.ticket.count({ where: this._dueWhere(workspaceId, resolved, hours, now) }).catch(() => null);
    const dueByChoice = {};
    for (const hours of AFTER_HOURS_CHOICES) dueByChoice[hours] = await count(hours);
    const resolvedNow = await prisma.ticket.count({ where: { workspaceId, origin: TICKET_ORIGIN.TICKETPULSE, status: { in: resolved } } }).catch(() => null);
    return {
      ...settings,
      choices: AFTER_HOURS_CHOICES.map((hours) => ({ hours, label: afterLabel(hours) })),
      resolvedNow,
      dueByChoice,
    };
  }

  /** One workspace: close up to SWEEP_BATCH tickets that have been Resolved long enough. */
  async closeDue(workspaceId, now = new Date()) {
    const settings = await this.getSettings(workspaceId);
    if (!settings.enabled) return { closed: 0, failed: 0 };
    const { resolved, closedName } = await this._statuses(workspaceId);
    if (!resolved.length) return { closed: 0, failed: 0 };
    const due = await prisma.ticket.findMany({
      where: this._dueWhere(workspaceId, resolved, settings.afterHours, now),
      select: { id: true, nativeNumber: true, origin: true, freshserviceTicketId: true },
      orderBy: [{ resolvedAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH * 2,
    });
    const { default: ticketService } = await import('./ticketService.js');
    let closed = 0;
    let failed = 0;
    for (const t of due) {
      if (closed + failed >= SWEEP_BATCH) break;
      const lastFail = this._failedAt.get(t.id);
      if (lastFail && now.getTime() - lastFail < RETRY_AFTER_MS) continue;
      try {
        const out = await ticketService.changeStatus(t.id, workspaceId, closedName, ACTOR);
        if (out?.changed !== false) closed += 1;
        this._failedAt.delete(t.id);
      } catch (err) {
        failed += 1;
        this._failedAt.set(t.id, now.getTime());
        logger.info(`Auto-close: ${ticketDisplayRef(t)} stays Resolved for now: ${err.message}`);
      }
    }
    if (closed || failed) {
      logger.info(`Auto-close: workspace ${workspaceId} closed ${closed} ticket(s) resolved for ${afterLabel(settings.afterHours)} or more${failed ? `, ${failed} could not close yet` : ''}`);
    }
    return { closed, failed };
  }

  /** Every workspace that has it on. Never throws. */
  async sweep(now = new Date()) {
    if (this._running) return { skipped: true };
    this._running = true;
    const out = { workspaces: 0, closed: 0, failed: 0 };
    try {
      const workspaces = await prisma.workspace.findMany({ where: { isActive: true, id: { notIn: SANDBOX_WORKSPACES } }, select: { id: true } });
      for (const { id } of workspaces) {
        const settings = await this.getSettings(id);
        if (!settings.enabled) continue;
        out.workspaces += 1;
        const r = await this.closeDue(id, now).catch((err) => {
          logger.warn(`Auto-close sweep failed for workspace ${id} (non-fatal): ${err.message}`);
          return { closed: 0, failed: 0 };
        });
        out.closed += r.closed;
        out.failed += r.failed;
      }
    } catch (err) {
      logger.warn(`Auto-close sweep failed (non-fatal): ${err.message}`);
    } finally {
      this._running = false;
    }
    return out;
  }

  start() {
    if (this._timer || process.env.AUTO_CLOSE_RESOLVED_ENABLED === 'false') return;
    this._timer = setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Auto-close of resolved tickets started (every ${Math.round(SWEEP_INTERVAL_MS / 1000)} s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export default new AutoCloseResolvedService();
