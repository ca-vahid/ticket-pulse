import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import statusService from './statusService.js';
import { TICKET_SOURCE, ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Bundle bursts of monitoring alerts (Vahid, 17 Oct 2026).
 *
 * Connected monitors (Sentinel's infrastructure checks) send one ticket per
 * server through POST /alert-occurrences, and grouping and alert correlation
 * deliberately leave those tickets alone. On 17 Oct 2026 one check raised a
 * "Storage / RAID hardware fault" on nine servers in five hours: nine
 * unowned tickets, none connected. A bundle is ONE parent incident over them:
 *
 *  - When `minCount` alerts of the SAME CHECK from the same monitor arrive
 *    within `windowMinutes`, a parent ticket is created and every open one
 *    becomes its child (parent_of). Later alerts of that check join the open
 *    parent at once, however much later they come.
 *  - Each server keeps its own ticket (one ticket per server, Vahid 11 Oct);
 *    the monitor still resolves each child when its own check passes.
 *  - One person works the burst: the parent goes through assignment like any
 *    ticket; queued AI runs on the children are set aside, and the 5-minute
 *    sweep gives open unowned children the parent's owner.
 *  - When every child is resolved or closed, the sweep resolves the parent
 *    with a note; auto-close closes it later like any resolved ticket.
 *
 * "Same check" = the first segment of the alert's fingerprint
 * ("hw-storage|BGC-VAN-HV52" -> "hw-storage"), else of its reference alert id,
 * else the title before its last ": " (the server name). The parent's
 * externalRef `bundle:<requesterId>:<check>:<time>` marks it, so grouping and
 * alert correlation leave it alone too, and an open one is found by prefix.
 *
 * Per workspace (Settings → Alert correlation → Connected monitors): off until
 * an admin saves it on; a settings read that fails counts as OFF.
 */
export const MIN_COUNT_CHOICES = Object.freeze([2, 3, 4, 5]);
export const WINDOW_CHOICES = Object.freeze([30, 60, 120, 240]);
export const DEFAULTS = Object.freeze({ enabled: false, minCount: 3, windowMinutes: 60 });
export const ACTOR = Object.freeze({ email: 'bundles@ticketpulse.internal', name: 'Ticket Pulse alert bundling', role: 'system', technicianId: null });
export const BUNDLE_PREFIX = 'bundle:';

const SANDBOX_WORKSPACES = [6, 7, 8, 9];
const SWEEP_INTERVAL_MS = Number(process.env.ALERT_BUNDLE_INTERVAL_MS) || 5 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
const MAX_CHILDREN = 100;
const cache = new Map();
const locks = new Map();

export const settingKey = (workspaceId) => `alert_bundling_ws${Number(workspaceId) || 0}`;

export function parseSettings(raw) {
  const out = { ...DEFAULTS, changedBy: null, changedAt: null };
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return out; }
  }
  if (!obj || typeof obj !== 'object') return out;
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (MIN_COUNT_CHOICES.includes(Number(obj.minCount))) out.minCount = Number(obj.minCount);
  if (WINDOW_CHOICES.includes(Number(obj.windowMinutes))) out.windowMinutes = Number(obj.windowMinutes);
  if (typeof obj.changedBy === 'string') out.changedBy = obj.changedBy.slice(0, 255);
  if (typeof obj.changedAt === 'string') out.changedAt = obj.changedAt;
  return out;
}

/** The check an alert belongs to: "hw-storage" for "hw-storage|BGC-VAN-HV52". */
export function checkOf({ fingerprintDisplay = null, alertId = null, title = null } = {}) {
  for (const raw of [fingerprintDisplay, alertId]) {
    const s = String(raw || '').trim();
    if (s.includes('|')) {
      const head = s.split('|')[0].trim().toLowerCase();
      if (head) return head.slice(0, 60);
    }
  }
  const t = String(title || '').trim();
  const cut = t.lastIndexOf(': ');
  return cut > 3 ? t.slice(0, cut).trim().toLowerCase().slice(0, 60) : null;
}

/** "[Infra] Storage / RAID hardware fault" from "[Infra] Storage / RAID hardware fault: BGC-VAN-HV52". */
export function titleStem(title) {
  const t = String(title || '').trim();
  const cut = t.lastIndexOf(': ');
  return cut > 3 ? t.slice(0, cut).trim() : t;
}

/** The server part of a child's title, for the parent's list. */
function serverOf(title) {
  const t = String(title || '').trim();
  const cut = t.lastIndexOf(': ');
  return cut > 3 ? t.slice(cut + 2).trim() : t;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

class AlertBundleService {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  async getSettings(workspaceId) {
    const id = Number(workspaceId);
    if (!Number.isFinite(id) || id <= 0) return parseSettings(null);
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value };
    let value;
    try {
      value = parseSettings(await settingsRepository.get(settingKey(id)));
    } catch (err) {
      logger.warn(`alertBundle: settings read failed for workspace ${id} (treating as off): ${err.message}`);
      return parseSettings(null);
    }
    cache.set(id, { value, at: Date.now() });
    return { ...value };
  }

  async setSettings(workspaceId, patch = {}, actor = null) {
    const id = Number(workspaceId);
    if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
    let current;
    try { current = parseSettings(await settingsRepository.get(settingKey(id))); } catch { current = parseSettings(null); }
    const next = { ...current };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (patch.minCount !== undefined) {
      if (!MIN_COUNT_CHOICES.includes(Number(patch.minCount))) throw new Error(`minCount must be one of ${MIN_COUNT_CHOICES.join(', ')}`);
      next.minCount = Number(patch.minCount);
    }
    if (patch.windowMinutes !== undefined) {
      if (!WINDOW_CHOICES.includes(Number(patch.windowMinutes))) throw new Error(`windowMinutes must be one of ${WINDOW_CHOICES.join(', ')}`);
      next.windowMinutes = Number(patch.windowMinutes);
    }
    next.changedBy = actor?.email || actor?.name || null;
    next.changedAt = new Date().toISOString();
    await settingsRepository.set(settingKey(id), JSON.stringify(next));
    cache.set(id, { value: next, at: Date.now() });
    return { ...next };
  }

  async _terminalNames(workspaceId) {
    return statusService.statusNamesForBase(workspaceId, ['Resolved', 'Closed']);
  }

  /** The open bundle parent for this monitor + check, if any. */
  async _openParent(workspaceId, requesterId, check, terminal) {
    return prisma.ticket.findFirst({
      where: {
        workspaceId,
        externalRef: { startsWith: `${BUNDLE_PREFIX}${requesterId}:${check}:` },
        status: { notIn: [...terminal, 'Deleted', 'Spam'] },
      },
      select: { id: true, nativeNumber: true, origin: true, freshserviceTicketId: true, assignedTechId: true, subject: true },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Called right after a monitoring alert CREATED a ticket. Joins it to an open
   * bundle of its check, or starts one when the burst is big enough. Never
   * throws: a bundling problem must not fail the alert call.
   */
  async afterAlertCreated(workspaceId, ticketId, { fingerprintDisplay = null, alertId = null, title = null } = {}, now = new Date()) {
    try {
      const settings = await this.getSettings(workspaceId);
      if (!settings.enabled || SANDBOX_WORKSPACES.includes(Number(workspaceId))) return { action: 'off' };
      const check = checkOf({ fingerprintDisplay, alertId, title });
      if (!check) return { action: 'no_check' };
      const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId }, select: { id: true, requesterId: true } });
      if (!ticket?.requesterId) return { action: 'no_requester' };
      return await withLock(`${workspaceId}:${ticket.requesterId}:${check}`, () => this._place(workspaceId, ticket, check, settings, now));
    } catch (err) {
      logger.warn(`Alert bundling skipped for ticket ${ticketId}: ${err.message}`);
      return { action: 'error', error: err.message };
    }
  }

  async _place(workspaceId, ticket, check, settings, now) {
    const terminal = await this._terminalNames(workspaceId);
    const parent = await this._openParent(workspaceId, ticket.requesterId, check, terminal);
    if (parent) {
      await this._adopt(workspaceId, parent, [ticket.id]);
      return { action: 'joined', parentId: parent.id };
    }

    // Open, unbundled alerts of this check from the same monitor in the window.
    const since = new Date(now.getTime() - settings.windowMinutes * 60000);
    const recent = await prisma.ticket.findMany({
      where: {
        workspaceId,
        requesterId: ticket.requesterId,
        createdAt: { gte: since },
        status: { notIn: [...terminal, 'Deleted', 'Spam'] },
        externalRef: { not: null },
        NOT: { externalRef: { startsWith: BUNDLE_PREFIX } },
      },
      select: { id: true, subject: true, customFields: true, priority: true, groupId: true, internalGroupId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const linked = new Set((await prisma.ticketLink.findMany({
      where: { workspaceId, kind: 'parent_of', relatedTicketId: { in: recent.map((t) => t.id) } },
      select: { relatedTicketId: true },
    })).map((l) => l.relatedTicketId));
    const same = recent.filter((t) => !linked.has(t.id)
      && checkOf({ fingerprintDisplay: t.customFields?.alert_fingerprint, title: t.subject }) === check);
    if (!same.some((t) => t.id === ticket.id)) same.push({ id: ticket.id, subject: null, priority: null });
    if (same.length < settings.minCount) return { action: 'waiting', count: same.length };

    const created = await this._createParent(workspaceId, ticket.requesterId, check, same, settings, now);
    await this._adopt(workspaceId, created, same.map((t) => t.id));
    logger.info(`Alert bundling: ${ticketDisplayRef(created)} bundles ${same.length} "${check}" alerts in workspace ${workspaceId}`);
    return { action: 'created', parentId: created.id, children: same.map((t) => t.id) };
  }

  async _createParent(workspaceId, requesterId, check, members, settings, now) {
    const first = members.find((t) => t.subject) || members[0];
    const requester = await prisma.requester.findUnique({ where: { id: requesterId }, select: { email: true, name: true } });
    const stem = titleStem(first.subject || check);
    const priority = Math.max(2, ...members.map((t) => Number(t.priority) || 0));
    const windowWords = settings.windowMinutes % 60 === 0 ? `${settings.windowMinutes / 60} hour${settings.windowMinutes === 60 ? '' : 's'}` : `${settings.windowMinutes} minutes`;
    const description = [
      `<p><strong>${members.length} servers raised the same alert within ${esc(windowWords)}.</strong> Ticket Pulse bundled them into this incident so one person works the burst.</p>`,
      '<p>Each server keeps its own ticket below. The monitor resolves each one when its check passes; this incident is resolved when they all are. Later alerts of the same check join it.</p>',
    ].join('');
    const { default: ticketService } = await import('./ticketService.js');
    return ticketService.createTicket(workspaceId, {
      subject: `${stem} — ${members.length} servers`.slice(0, 500),
      description,
      priority: Math.min(4, priority),
      requesterEmail: requester?.email,
      requesterName: requester?.name || undefined,
      externalRef: `${BUNDLE_PREFIX}${requesterId}:${check}:${now.toISOString()}`,
      ...(first.groupId ? { groupId: first.groupId } : {}),
      ...(first.internalGroupId ? { internalGroupId: first.internalGroupId } : {}),
    }, ACTOR, { sourceChannel: TICKET_SOURCE.MONITORING_ALERT, suppressRequesterAck: true });
  }

  /** Link children under the parent, set their AI runs aside, give them its owner, and note who joined. */
  async _adopt(workspaceId, parent, childIds) {
    const { default: ticketLinkService } = await import('./ticketLinkService.js');
    const { default: ticketService } = await import('./ticketService.js');
    const joined = [];
    for (const childId of childIds.slice(0, MAX_CHILDREN)) {
      try {
        await ticketLinkService.setParent(childId, workspaceId, { parentTicketId: parent.id }, ACTOR);
      } catch (err) {
        logger.warn(`Alert bundling: could not put ticket ${childId} under ${ticketDisplayRef(parent)}: ${err.message}`);
        continue;
      }
      await prisma.assignmentPipelineRun.updateMany({
        where: { ticketId: childId, status: 'queued' },
        data: { status: 'superseded', errorMessage: `Part of the alert bundle ${ticketDisplayRef(parent)}; the bundle is worked as one` },
      }).catch(() => {});
      joined.push(childId);
    }
    if (parent.assignedTechId) await this._giveOwner(workspaceId, parent, joined);
    // Keep "— N servers" in the title true as servers join (a person's own title is left alone).
    const m = /^(.*) — (\d+) servers$/.exec(String(parent.subject || ''));
    if (joined.length && m) {
      const total = await prisma.ticketLink.count({ where: { workspaceId, ticketId: parent.id, kind: 'parent_of' } }).catch(() => null);
      if (total && total !== Number(m[2])) {
        await Promise.resolve().then(() => ticketService.updateTicketFields(parent.id, workspaceId, { subject: `${m[1]} — ${total} servers` }, ACTOR, { emitEvent: false }))
          .catch((err) => logger.info(`Alert bundling: title of ${ticketDisplayRef(parent)} not updated: ${err.message}`));
      }
    }
    if (joined.length) {
      const rows = await prisma.ticket.findMany({ where: { id: { in: joined } }, select: { id: true, nativeNumber: true, origin: true, freshserviceTicketId: true, subject: true } });
      const list = rows.map((r) => `${ticketDisplayRef(r)} ${serverOf(r.subject)}`);
      await ticketService.addPrivateNote(parent.id, workspaceId, {
        bodyHtml: `<p><strong>${joined.length === 1 ? 'Joined' : `${joined.length} alerts bundled`}:</strong> ${list.map(esc).join(', ')}</p>`,
        bodyText: `${joined.length === 1 ? 'Joined' : `${joined.length} alerts bundled`}: ${list.join(', ')}`,
      }, ACTOR, [], { systemNote: true }).catch((err) => logger.warn(`Alert bundling: note on ${parent.id} failed: ${err.message}`));
    }
    return joined;
  }

  /** Open children nobody owns take the parent's owner. */
  async _giveOwner(workspaceId, parent, childIds = null) {
    if (!parent.assignedTechId) return 0;
    const { childrenOf } = await import('./ticketRollUpService.js');
    const terminal = await this._terminalNames(workspaceId);
    const children = childIds
      ? await prisma.ticket.findMany({ where: { id: { in: childIds } }, select: { id: true, status: true, assignedTechId: true } })
      : await childrenOf(parent.id, workspaceId);
    const { default: ticketService } = await import('./ticketService.js');
    let given = 0;
    for (const child of children) {
      if (terminal.includes(child.status) || ['Deleted', 'Spam'].includes(child.status)) continue;
      const owner = child.assignedTechId ?? (await prisma.ticket.findUnique({ where: { id: child.id }, select: { assignedTechId: true } }))?.assignedTechId;
      if (owner) continue;
      try {
        await ticketService.assignTicket(child.id, workspaceId, parent.assignedTechId, ACTOR, { allowAssignableOnly: true });
        given += 1;
      } catch (err) {
        logger.info(`Alert bundling: ticket ${child.id} keeps no owner for now: ${err.message}`);
      }
    }
    return given;
  }

  /**
   * Bursts already open (the ones from before bundling was on, or two alerts
   * that raced): open, unbundled monitoring alerts of the last week, by monitor
   * + check. A check with an open incident gets every one of them; a check
   * with `minCount` inside any `windowMinutes` span gets a new incident over
   * all its open alerts.
   */
  async bundleOpenBursts(workspaceId, now = new Date()) {
    const settings = await this.getSettings(workspaceId);
    if (!settings.enabled) return { created: 0, joined: 0 };
    const terminal = await this._terminalNames(workspaceId);
    const open = await prisma.ticket.findMany({
      where: {
        workspaceId,
        source: TICKET_SOURCE.MONITORING_ALERT,
        createdAt: { gte: new Date(now.getTime() - 7 * 24 * 3600e3) },
        status: { notIn: [...terminal, 'Deleted', 'Spam'] },
        externalRef: { not: null },
        NOT: { externalRef: { startsWith: BUNDLE_PREFIX } },
        requesterId: { not: null },
      },
      select: { id: true, requesterId: true, subject: true, customFields: true, priority: true, groupId: true, internalGroupId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    if (!open.length) return { created: 0, joined: 0 };
    const linked = new Set((await prisma.ticketLink.findMany({
      where: { workspaceId, kind: 'parent_of', relatedTicketId: { in: open.map((t) => t.id) } },
      select: { relatedTicketId: true },
    })).map((l) => l.relatedTicketId));
    const groups = new Map();
    for (const t of open) {
      if (linked.has(t.id)) continue;
      const check = checkOf({ fingerprintDisplay: t.customFields?.alert_fingerprint, title: t.subject });
      if (!check) continue;
      const key = `${t.requesterId}:${check}`;
      if (!groups.has(key)) groups.set(key, { requesterId: t.requesterId, check, members: [] });
      groups.get(key).members.push(t);
    }
    let created = 0;
    let joined = 0;
    for (const { requesterId, check, members } of groups.values()) {
      await withLock(`${workspaceId}:${requesterId}:${check}`, async () => {
        const parent = await this._openParent(workspaceId, requesterId, check, terminal);
        if (parent) {
          joined += (await this._adopt(workspaceId, parent, members.map((t) => t.id))).length;
          return;
        }
        const spanMs = settings.windowMinutes * 60000;
        const burst = members.some((m, i) => members.filter((x, j) => j >= i && x.createdAt - m.createdAt <= spanMs).length >= settings.minCount);
        if (!burst) return;
        const made = await this._createParent(workspaceId, requesterId, check, members, settings, now);
        await this._adopt(workspaceId, made, members.map((t) => t.id));
        logger.info(`Alert bundling: ${ticketDisplayRef(made)} bundles ${members.length} open "${check}" alerts in workspace ${workspaceId}`);
        created += 1;
      }).catch((err) => logger.warn(`Alert bundling: open "${check}" alerts not bundled: ${err.message}`));
    }
    return { created, joined };
  }

  /** One workspace: owners for new children, and resolve parents whose children are all done. */
  async tidy(workspaceId) {
    const terminal = await this._terminalNames(workspaceId);
    const parents = await prisma.ticket.findMany({
      where: { workspaceId, externalRef: { startsWith: BUNDLE_PREFIX }, status: { notIn: [...terminal, 'Deleted', 'Spam'] } },
      select: { id: true, nativeNumber: true, origin: true, freshserviceTicketId: true, assignedTechId: true, subject: true },
      take: 50,
    });
    const { childrenOf } = await import('./ticketRollUpService.js');
    const { default: ticketService } = await import('./ticketService.js');
    let owned = 0;
    let resolved = 0;
    for (const parent of parents) {
      owned += await this._giveOwner(workspaceId, parent).catch(() => 0);
      const children = await childrenOf(parent.id, workspaceId);
      if (!children.length) continue;
      const done = children.every((c) => terminal.includes(c.status) || ['Deleted', 'Spam'].includes(c.status));
      if (!done) continue;
      const resolvedName = (await statusService.statusNamesForBase(workspaceId, ['Resolved']))[0] || 'Resolved';
      try {
        await ticketService.addPrivateNote(parent.id, workspaceId, {
          bodyText: `All ${children.length} servers in this bundle are resolved or closed. Resolved automatically.`,
          bodyHtml: `<p>All ${children.length} servers in this bundle are resolved or closed. Resolved automatically.</p>`,
        }, ACTOR, [], { systemNote: true });
        await ticketService.changeStatus(parent.id, workspaceId, resolvedName, ACTOR);
        resolved += 1;
      } catch (err) {
        logger.info(`Alert bundling: ${ticketDisplayRef(parent)} stays open for now: ${err.message}`);
      }
    }
    return { owned, resolved };
  }

  async sweep() {
    if (this._running) return { skipped: true };
    this._running = true;
    const out = { workspaces: 0, owned: 0, resolved: 0 };
    try {
      const workspaces = await prisma.workspace.findMany({ where: { isActive: true, id: { notIn: SANDBOX_WORKSPACES } }, select: { id: true } });
      for (const { id } of workspaces) {
        const b = await this.bundleOpenBursts(id).catch((err) => { logger.warn(`Alert bundling of open bursts failed for workspace ${id}: ${err.message}`); return { created: 0, joined: 0 }; });
        out.created = (out.created || 0) + b.created;
        // Parents are tidied even after bundling is switched off: the ones that exist still need it.
        const r = await this.tidy(id).catch((err) => { logger.warn(`Alert bundle sweep failed for workspace ${id}: ${err.message}`); return { owned: 0, resolved: 0 }; });
        if (r.owned || r.resolved) out.workspaces += 1;
        out.owned += r.owned;
        out.resolved += r.resolved;
      }
      if (out.created || out.owned || out.resolved) logger.info(`Alert bundle sweep: ${out.created || 0} bundle(s) opened, ${out.owned} children given the bundle's owner, ${out.resolved} bundle(s) resolved`);
    } catch (err) {
      logger.warn(`Alert bundle sweep failed (non-fatal): ${err.message}`);
    } finally {
      this._running = false;
    }
    return out;
  }

  start() {
    if (this._timer || process.env.ALERT_BUNDLE_SWEEP_ENABLED === 'false') return;
    this._timer = setInterval(() => { this.sweep().catch(() => {}); }, SWEEP_INTERVAL_MS);
    this._timer.unref?.();
    logger.info(`Alert bundle sweep started (every ${Math.round(SWEEP_INTERVAL_MS / 1000)} s)`);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export default new AlertBundleService();
