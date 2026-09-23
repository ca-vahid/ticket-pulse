// Per-workspace ticket-status registry (ticket_status_definitions, QA 08-04
// #12 Phase 8a). The single source of truth for which statuses exist in a
// workspace and — via baseStatus — how each behaves: every status maps to one
// of the 4 canonical base statuses (Open/Pending/Resolved/Closed) so
// lifecycle logic (SLA, terminal detection, assignment episodes, FS
// write-back in 8c) keys on the base, never the label. Mirrors the
// ticketTypeService registry pattern.
//
// Resilience contract: read paths NEVER hard-fail on a missing/unreadable
// registry (pre-migration deploys, test prisma mocks without the model) —
// they fall back to the 4 canonical system statuses, which keeps behavior
// identical to the pre-registry hardcoded allowlists.
import prisma from './prisma.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { setWorkspaceBindings, titleCaseStatusLabel } from '../utils/fsStatusBindings.js';

export const BASE_STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];
export const TERMINAL_BASE_STATUSES = ['Resolved', 'Closed'];

// FreshService numeric status codes → base (raw FS payloads sometimes carry
// the int; keep parity with freshserviceTransformer.STATUS_MAP).
const FS_CODE_BASES = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };

/**
 * Workspace-less heuristic base guess for labels the registry doesn't know —
 * FS numeric codes first, then the substring rules the pre-8c consumers used
 * (lifecycle terminal detection, public status page tone). 'Deleted'/'Spam'
 * and anything unrecognizable stay null.
 */
export function heuristicBaseStatus(status) {
  const raw = String(status ?? '').trim();
  if (!raw) return null;
  if (FS_CODE_BASES[raw] !== undefined) return FS_CODE_BASES[raw];
  if (BASE_STATUSES.includes(raw)) return raw;
  const text = raw.toLowerCase();
  if (text.includes('resolved')) return 'Resolved';
  if (text.includes('closed')) return 'Closed';
  if (text.includes('pending') || text.includes('waiting') || text.includes('on hold') || text.includes('hold')) return 'Pending';
  if (text.includes('open') || text.includes('progress')) return 'Open';
  return null;
}

// Same palette as the ticket-type registry (TYPE_COLOR_TONES on the frontend).
const COLORS = new Set(['slate', 'orange', 'violet', 'red', 'blue', 'emerald', 'amber', 'cyan', 'pink']);

const SYSTEM_COLOR = { Open: 'blue', Pending: 'amber', Resolved: 'emerald', Closed: 'slate' };

/** The 4 canonical rows, synthesized for workspaces the seed hasn't reached. */
function canonicalFallbackRows(workspaceId) {
  return BASE_STATUSES.map((name, i) => ({
    id: null,
    workspaceId: Number(workspaceId) || null,
    name,
    baseStatus: name,
    color: SYSTEM_COLOR[name],
    sortOrder: i,
    isSystem: true,
    isActive: true,
  }));
}

// Small bounded read cache — the registry is read on every status validation
// but changes only via Settings CRUD. Explicitly invalidated on writes; the
// TTL guards multi-instance drift (same shape as internalDomainsCache /
// ticketTypeService).
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map(); // workspaceId -> { at, rows }
// Concurrent cold-cache reads (e.g. getQueueStats resolving three base
// scopes in one Promise.all) share a single in-flight DB read instead of
// each firing their own (Phase 8b hot-path contract).
const pendingReads = new Map(); // workspaceId -> Promise<rows>

function readCache(workspaceId) {
  const hit = cache.get(workspaceId);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.rows;
}

function writeCache(workspaceId, rows) {
  if (cache.size >= CACHE_MAX && !cache.has(workspaceId)) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(workspaceId, { at: Date.now(), rows });
}

export function invalidateStatusCache(workspaceId) {
  if (workspaceId === undefined) {
    cache.clear();
    pendingReads.clear();
  } else {
    cache.delete(Number(workspaceId));
    pendingReads.delete(Number(workspaceId));
  }
  // Registry writes can change a FreshService binding; refresh the in-memory
  // map the (synchronous) transformer reads. Fire-and-forget, never fatal.
  statusServiceRef?.loadFsBindings(workspaceId).catch(() => {});
}

// FreshService's fixed statuses; anything else is tenant-defined and binds
// to a registry row (Pending Response build, 23 Sep 2026).
const FS_FIXED_STATUS_IDS = new Set([2, 3, 4, 5]);
// Labels the transformer used for 6/7 before bindings existed.
const LEGACY_FS_STATUS_LABELS = { 6: 'Waiting on Customer', 7: 'Waiting on Third Party' };
// Last FreshService labels read per workspace (id -> label), for fallbacks.
const fsLabelsByWorkspace = new Map();
let statusServiceRef = null;

class StatusService {
  /**
   * All definitions for a workspace (active first, then sortOrder). Cached.
   * Falls back to the 4 canonical statuses when the registry is unreadable
   * or empty (pre-seed workspace, down migration, mocked prisma).
   */
  async listStatuses(workspaceId, { includeInactive = false } = {}) {
    const wsId = Number(workspaceId);
    let rows = readCache(wsId);
    if (!rows) {
      let inflight = pendingReads.get(wsId);
      if (!inflight) {
        inflight = (async () => {
          let fetched = null;
          try {
            fetched = await prisma.ticketStatusDefinition.findMany({
              where: { workspaceId: wsId },
              orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
            });
          } catch (err) {
            logger.warn(`Status registry unavailable for ws${wsId} — canonical fallback (${err.message})`);
          }
          if (!fetched || fetched.length === 0) fetched = canonicalFallbackRows(wsId);
          writeCache(wsId, fetched);
          return fetched;
        })();
        pendingReads.set(wsId, inflight);
        inflight.finally(() => pendingReads.delete(wsId)).catch(() => {});
      }
      rows = await inflight;
    }
    return includeInactive ? rows : rows.filter((r) => r.isActive);
  }

  /**
   * Base status (Open/Pending/Resolved/Closed) for a status label. Inactive
   * definitions still resolve — retired statuses linger on historical tickets.
   * Unknown labels: an exact canonical name maps to itself (legacy rows that
   * predate the registry), anything else is null.
   */
  async baseStatusOf(workspaceId, name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return null;
    const rows = await this.listStatuses(workspaceId, { includeInactive: true });
    const match = rows.find((r) => r.name.toLowerCase() === key);
    if (match) return match.baseStatus;
    return BASE_STATUSES.includes(String(name).trim()) ? String(name).trim() : null;
  }

  /**
   * baseStatusOf + heuristic fallback (FS ints, substrings) for labels the
   * registry can't place — FS-born payload labels, legacy 'Waiting on
   * Customer' rows. The 8c contract for consumers that must never come up
   * empty-handed on real-world data (lifecycle events, FS write-back codes,
   * public status tone).
   */
  async resolveBaseStatus(workspaceId, name) {
    return (await this.baseStatusOf(workspaceId, name)) ?? heuristicBaseStatus(name);
  }

  /** Active status names whose base is one of the given base statuses. */
  async statusNamesForBase(workspaceId, baseOrBases) {
    const bases = (Array.isArray(baseOrBases) ? baseOrBases : [baseOrBases]).filter(Boolean);
    const rows = await this.listStatuses(workspaceId);
    return rows.filter((r) => bases.includes(r.baseStatus)).map((r) => r.name);
  }

  /**
   * Hot-path bundle (Phase 8b): resolve the workspace's ACTIVE status names
   * into base-keyed Sets ONCE per request, then test ticket rows synchronously
   * (dashboards / statsCalculator iterate thousands of tickets — never await
   * a registry lookup per ticket). Backed by the same 60s cache as
   * listStatuses, so calling this per-request is one cache hit.
   * Shape: { open, pending, openLike, terminal } — Sets of names.
   */
  async baseStatusSets(workspaceId) {
    const rows = await this.listStatuses(workspaceId);
    const open = new Set();
    const pending = new Set();
    const terminal = new Set();
    for (const r of rows) {
      if (r.baseStatus === 'Open') open.add(r.name);
      else if (r.baseStatus === 'Pending') pending.add(r.name);
      else if (TERMINAL_BASE_STATUSES.includes(r.baseStatus)) terminal.add(r.name);
    }
    return { open, pending, openLike: new Set([...open, ...pending]), terminal };
  }

  /**
   * Case-insensitive match of free-form input to an ACTIVE definition.
   * Returns the canonical-cased name, or null when nothing matches.
   */
  async normalizeStatusName(workspaceId, input) {
    const key = String(input ?? '').trim().toLowerCase();
    if (!key) return null;
    const rows = await this.listStatuses(workspaceId);
    return rows.find((r) => r.name.toLowerCase() === key)?.name ?? null;
  }

  /**
   * Validation chokepoint: throws ValidationError naming the valid values,
   * returns the canonical-cased name otherwise. With only the 4 system
   * statuses configured this is byte-for-byte the old NATIVE_TICKET_STATUSES
   * check (same accepted set, same message shape).
   */
  async assertValidStatus(workspaceId, name) {
    const normalized = await this.normalizeStatusName(workspaceId, name);
    if (!normalized) {
      const valid = (await this.listStatuses(workspaceId)).map((r) => r.name).join(', ');
      throw new ValidationError(`Status must be one of: ${valid}`);
    }
    return normalized;
  }

  // ---------- Settings CRUD ----------

  async _requireRow(workspaceId, id) {
    const row = await prisma.ticketStatusDefinition.findFirst({
      where: { id: Number(id), workspaceId: Number(workspaceId) },
    });
    if (!row) throw new NotFoundError('Ticket status not found');
    return row;
  }

  async _assertNameFree(workspaceId, name, { exceptId = null } = {}) {
    const rows = await prisma.ticketStatusDefinition.findMany({
      where: { workspaceId: Number(workspaceId) },
      select: { id: true, name: true },
    });
    const clash = rows.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== exceptId);
    if (clash) throw new ValidationError(`A status named "${clash.name}" already exists in this workspace`);
  }

  _cleanName(value) {
    const name = String(value ?? '').trim();
    if (!name || name.length > 50) throw new ValidationError('name is required (max 50 chars)');
    return name;
  }

  _cleanColor(value) {
    if (value === null || value === undefined || value === '') return null;
    const color = String(value).trim().toLowerCase();
    if (!COLORS.has(color)) throw new ValidationError(`color must be one of: ${[...COLORS].join(', ')}`);
    return color;
  }

  async createStatus(workspaceId, data = {}, updatedBy) {
    const name = this._cleanName(data.name);
    const baseStatus = String(data.baseStatus ?? '').trim();
    if (!BASE_STATUSES.includes(baseStatus)) {
      throw new ValidationError(`baseStatus must be one of: ${BASE_STATUSES.join(', ')}`);
    }
    await this._assertNameFree(workspaceId, name);
    let sortOrder = Number(data.sortOrder);
    if (!Number.isFinite(sortOrder)) {
      const max = await prisma.ticketStatusDefinition.aggregate({
        where: { workspaceId: Number(workspaceId) },
        _max: { sortOrder: true },
      });
      sortOrder = (max?._max?.sortOrder ?? -1) + 1;
    }
    const created = await prisma.ticketStatusDefinition.create({
      data: {
        workspaceId: Number(workspaceId),
        name,
        baseStatus,
        color: this._cleanColor(data.color),
        sortOrder,
        isSystem: false,
        isActive: true,
      },
    });
    invalidateStatusCache(workspaceId);
    logger.info(`Ticket status created: ws${workspaceId} "${name}" (base ${baseStatus}) by ${updatedBy || 'unknown'}`);
    return created;
  }

  /**
   * Rename / recolor / reorder / (non-system, confirmed) base change.
   * A rename ALSO renames every ticket in the workspace carrying the old
   * label, transactionally — the label is the stored value, so a dangling old
   * label would silently fall out of every filter.
   */
  async updateStatus(workspaceId, id, data = {}, updatedBy) {
    const existing = await this._requireRow(workspaceId, id);
    const patch = {};

    if (data.name !== undefined) {
      const name = this._cleanName(data.name);
      if (name !== existing.name) {
        await this._assertNameFree(workspaceId, name, { exceptId: existing.id });
        patch.name = name;
      }
    }
    if (data.color !== undefined) patch.color = this._cleanColor(data.color);
    if (data.freshserviceStatusId !== undefined) {
      const raw = data.freshserviceStatusId;
      const fsId = raw === null || raw === '' ? null : Number(raw);
      if (fsId !== null && (!Number.isInteger(fsId) || FS_FIXED_STATUS_IDS.has(fsId) || fsId < 2)) {
        throw new ValidationError('freshserviceStatusId must be a FreshService custom status id (6 or above), or null');
      }
      if (fsId !== null) {
        const taken = await prisma.ticketStatusDefinition.findFirst({
          where: { workspaceId: Number(workspaceId), freshserviceStatusId: fsId, NOT: { id: existing.id } },
          select: { name: true },
        });
        if (taken) throw new ValidationError(`FreshService status ${fsId} is already linked to "${taken.name}"`);
      }
      patch.freshserviceStatusId = fsId;
    }
    if (data.sortOrder !== undefined) {
      const sortOrder = Number(data.sortOrder);
      if (!Number.isFinite(sortOrder)) throw new ValidationError('sortOrder must be a number');
      patch.sortOrder = sortOrder;
    }
    if (data.baseStatus !== undefined && String(data.baseStatus) !== existing.baseStatus) {
      if (existing.isSystem) {
        throw new ValidationError(`"${existing.name}" is a system status — its base behavior is fixed`);
      }
      const baseStatus = String(data.baseStatus).trim();
      if (!BASE_STATUSES.includes(baseStatus)) {
        throw new ValidationError(`baseStatus must be one of: ${BASE_STATUSES.join(', ')}`);
      }
      if (data.confirmBaseChange !== true) {
        throw new ValidationError('Changing the base status changes how tickets with this status behave (SLA, terminal logic). Pass confirmBaseChange: true to proceed.');
      }
      patch.baseStatus = baseStatus;
    }

    if (Object.keys(patch).length === 0) return existing;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.ticketStatusDefinition.update({
        where: { id: existing.id },
        data: patch,
      });
      if (patch.name && patch.name !== existing.name) {
        const renamed = await tx.ticket.updateMany({
          where: { workspaceId: Number(workspaceId), status: existing.name },
          data: { status: patch.name },
        });
        logger.info(`Ticket status renamed: ws${workspaceId} "${existing.name}" -> "${patch.name}" (${renamed.count} tickets relabeled) by ${updatedBy || 'unknown'}`);
      }
      return row;
    });
    invalidateStatusCache(workspaceId);
    return updated;
  }

  /**
   * Retire, never delete: tickets keep the label (baseStatusOf still resolves
   * it via the inactive lookup); it just can't be chosen for new changes.
   * System rows can't be retired — lifecycle logic needs all 4 bases reachable.
   */
  async deactivateStatus(workspaceId, id, updatedBy) {
    const existing = await this._requireRow(workspaceId, id);
    if (existing.isSystem) {
      throw new ValidationError(`"${existing.name}" is a system status and cannot be deactivated`);
    }
    if (!existing.isActive) return existing;
    const updated = await prisma.ticketStatusDefinition.update({
      where: { id: existing.id },
      data: { isActive: false },
    });
    invalidateStatusCache(workspaceId);
    logger.info(`Ticket status retired: ws${workspaceId} "${existing.name}" by ${updatedBy || 'unknown'}`);
    return updated;
  }

  // ---------- FreshService status binding (23 Sep 2026) ----------

  /**
   * Load registry rows bound to FreshService status ids into the in-memory
   * map (utils/fsStatusBindings.js) the transformer and write-back read.
   * One workspace, or all when workspaceId is undefined. Never throws.
   */
  async loadFsBindings(workspaceId) {
    try {
      const where = workspaceId === undefined ? {} : { id: Number(workspaceId) };
      const workspaces = await prisma.workspace.findMany({
        where,
        select: { id: true, freshserviceWorkspaceId: true },
      });
      const rows = await prisma.ticketStatusDefinition.findMany({
        where: {
          ...(workspaceId === undefined ? {} : { workspaceId: Number(workspaceId) }),
          freshserviceStatusId: { not: null },
        },
        select: { workspaceId: true, name: true, freshserviceStatusId: true },
      });
      for (const ws of workspaces) {
        setWorkspaceBindings(ws.id, {
          fsWorkspaceId: ws.freshserviceWorkspaceId ?? null,
          bindings: rows.filter((r) => r.workspaceId === ws.id).map((r) => ({ fsId: r.freshserviceStatusId, name: r.name })),
          fsLabels: fsLabelsByWorkspace.get(ws.id) || null,
        });
      }
      return { workspaces: workspaces.length, bindings: rows.length };
    } catch (err) {
      logger.debug?.(`FreshService status bindings not loaded (${err.message})`);
      return { workspaces: 0, bindings: 0 };
    }
  }

  /**
   * Read FreshService's status choices for a workspace and make sure every
   * tenant status (id > 5) has a registry row bound to it:
   *   - a row with the same name (case-insensitive) is bound;
   *   - otherwise a row is created with FreshService's label in title case
   *     ("Pending response" -> "Pending Response"), base from the label
   *     (Pending when unclear) — but ONLY where the workspace's tickets
   *     actually carry that status. FreshService offers its custom statuses
   *     tenant-wide; "Pending response" is IT's process (Vahid, 23 Sep 2026),
   *     so a workspace that never uses it must not get it in its status list.
   *     A later ticket in that status creates the row on the next pass.
   * Existing bindings are kept; fsDetectedAt is stamped. Never deletes.
   */
  async syncFsStatusChoices(workspaceId, client, fsWorkspaceId) {
    const fields = typeof client.listTicketFormFields === 'function'
      ? await client.listTicketFormFields({ workspace_id: Number(fsWorkspaceId) })
      : ((await client.client.get('/ticket_form_fields', { params: { workspace_id: Number(fsWorkspaceId) } })).data?.ticket_fields || []);
    const statusField = (fields || []).find((f) => f.name === 'status');
    const choices = Array.isArray(statusField?.choices) ? statusField.choices : [];
    if (!choices.length) {
      logger.warn(`Status choice sync: no status field for ws${workspaceId}`);
      return { detected: 0, bound: 0, created: 0 };
    }
    fsLabelsByWorkspace.set(Number(workspaceId), Object.fromEntries(choices.map((c) => [Number(c.id), String(c.value || '')])));

    const rows = await prisma.ticketStatusDefinition.findMany({ where: { workspaceId: Number(workspaceId) } });
    const now = new Date();
    let bound = 0;
    let created = 0;
    for (const choice of choices) {
      const fsId = Number(choice.id);
      const label = String(choice.value || '').trim();
      if (!Number.isInteger(fsId) || FS_FIXED_STATUS_IDS.has(fsId) || !label) continue;
      const already = rows.find((r) => r.freshserviceStatusId === fsId);
      if (already) {
        await prisma.ticketStatusDefinition.update({ where: { id: already.id }, data: { fsDetectedAt: now } });
        continue;
      }
      const name = titleCaseStatusLabel(label).slice(0, 50);
      const byName = rows.find((r) => r.name.toLowerCase() === label.toLowerCase() || r.name.toLowerCase() === name.toLowerCase());
      if (byName) {
        if (byName.freshserviceStatusId === null || byName.freshserviceStatusId === undefined) {
          await prisma.ticketStatusDefinition.update({
            where: { id: byName.id },
            data: { freshserviceStatusId: fsId, fsDetectedAt: now },
          });
          bound += 1;
          logger.info(`Status choice sync: ws${workspaceId} "${byName.name}" bound to FreshService status ${fsId} ("${label}")`);
        }
        continue;
      }
      // In use here? Tickets synced under this name, or under the old fixed
      // labels for 6/7 ("Waiting on Customer" / "Waiting on Third Party").
      const legacyLabel = LEGACY_FS_STATUS_LABELS[fsId];
      const inUse = await prisma.ticket.count({
        where: { workspaceId: Number(workspaceId), status: { in: [name, label, ...(legacyLabel ? [legacyLabel] : [])] } },
      }).catch(() => 0);
      if (!inUse) continue;
      const max = await prisma.ticketStatusDefinition.aggregate({ where: { workspaceId: Number(workspaceId) }, _max: { sortOrder: true } });
      await prisma.ticketStatusDefinition.create({
        data: {
          workspaceId: Number(workspaceId),
          name,
          baseStatus: heuristicBaseStatus(label) || 'Pending',
          color: 'amber',
          sortOrder: (max?._max?.sortOrder ?? -1) + 1,
          isSystem: false,
          isActive: true,
          freshserviceStatusId: fsId,
          fsDetectedAt: now,
        },
      });
      created += 1;
      logger.info(`Status choice sync: ws${workspaceId} created "${name}" for FreshService status ${fsId} ("${label}")`);
    }
    cache.delete(Number(workspaceId));
    pendingReads.delete(Number(workspaceId));
    await this.loadFsBindings(workspaceId);
    return { detected: choices.length, bound, created };
  }

  /** FreshService choices last read for a workspace ({ id: label }), or null. */
  fsStatusLabels(workspaceId) {
    return fsLabelsByWorkspace.get(Number(workspaceId)) || null;
  }

  async reactivateStatus(workspaceId, id, updatedBy) {
    const existing = await this._requireRow(workspaceId, id);
    if (existing.isActive) return existing;
    const updated = await prisma.ticketStatusDefinition.update({
      where: { id: existing.id },
      data: { isActive: true },
    });
    invalidateStatusCache(workspaceId);
    logger.info(`Ticket status reactivated: ws${workspaceId} "${existing.name}" by ${updatedBy || 'unknown'}`);
    return updated;
  }
}

const statusService = new StatusService();
statusServiceRef = statusService;
export default statusService;
