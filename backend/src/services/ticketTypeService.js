// Per-workspace ticket-type registry (ticket_type_definitions). The single
// source of truth for which ticket types exist in a workspace, how they map
// to FreshService, how the LLM should understand them, and how pills render.
// Replaces the hardcoded ['Incident', 'Service Request'] vocabulary.
import prisma from './prisma.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import logger from '../utils/logger.js';

// Small bounded read cache — type lists are read on every ticket create/update
// validation and every pipeline run, but change only via Settings CRUD or the
// FS sync pass. Explicitly invalidated on writes; TTL guards multi-instance.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map(); // workspaceId -> { at, rows }

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

export function invalidateTicketTypeCache(workspaceId) {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(Number(workspaceId));
}

const COLORS = new Set(['slate', 'orange', 'violet', 'red', 'blue', 'emerald', 'amber', 'cyan', 'pink']);

class TicketTypeService {
  /** All definitions for a workspace (active first, then sortOrder). Cached. */
  async listTypes(workspaceId, { includeInactive = true } = {}) {
    const wsId = Number(workspaceId);
    let rows = readCache(wsId);
    if (!rows) {
      rows = await prisma.ticketTypeDefinition.findMany({
        where: { workspaceId: wsId },
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
      writeCache(wsId, rows);
    }
    return includeInactive ? rows : rows.filter((r) => r.isActive);
  }

  async getActiveTypes(workspaceId) {
    return this.listTypes(workspaceId, { includeInactive: false });
  }

  /** Types the assignment LLM is allowed to choose from. */
  async getAiAssignableTypes(workspaceId) {
    return (await this.getActiveTypes(workspaceId)).filter((t) => t.aiAssignable);
  }

  /** Workspace default for TP-born creates (isDefault, else first active). */
  async getDefaultType(workspaceId) {
    const active = await this.getActiveTypes(workspaceId);
    return active.find((t) => t.isDefault) || active[0] || null;
  }

  /**
   * Normalize a free-form value to this workspace's canonical type name.
   * Matches name (case-insensitive) then aliases. Throws ValidationError
   * naming the valid values. Pass allowInactive for read paths that must
   * tolerate retired-but-historical values.
   */
  async normalizeTypeName(workspaceId, value, { allowInactive = false } = {}) {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key) throw new ValidationError('ticketType is required');
    const rows = await this.listTypes(workspaceId, { includeInactive: allowInactive });
    const match = rows.find((t) => t.name.toLowerCase() === key)
      || rows.find((t) => (t.aliases || []).some((a) => String(a).toLowerCase() === key));
    if (!match) {
      const valid = rows.filter((t) => t.isActive).map((t) => t.name).join(', ') || '(none configured)';
      throw new ValidationError(`ticketType must be one of: ${valid}`);
    }
    return match.name;
  }

  /** Definition row for a canonical/aliased value, or null (no throw). */
  async resolveType(workspaceId, value) {
    try {
      const name = await this.normalizeTypeName(workspaceId, value, { allowInactive: true });
      const rows = await this.listTypes(workspaceId);
      return rows.find((t) => t.name === name) || null;
    } catch {
      return null;
    }
  }

  // ---------- Settings CRUD ----------

  async createType(workspaceId, data, updatedBy) {
    const payload = this._validatePayload(data);
    const created = await prisma.$transaction(async (tx) => {
      if (payload.isDefault) {
        await tx.ticketTypeDefinition.updateMany({ where: { workspaceId: Number(workspaceId) }, data: { isDefault: false } });
      }
      return tx.ticketTypeDefinition.create({
        data: { ...payload, workspaceId: Number(workspaceId), source: 'manual' },
      });
    });
    invalidateTicketTypeCache(workspaceId);
    logger.info(`Ticket type created: ws${workspaceId} "${created.name}" by ${updatedBy || 'unknown'}`);
    return created;
  }

  async updateType(workspaceId, id, data, updatedBy) {
    const existing = await prisma.ticketTypeDefinition.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } });
    if (!existing) throw new NotFoundError('Ticket type not found');
    const payload = this._validatePayload(data, { partial: true });
    // Renaming would orphan the string values on historical tickets — the
    // Settings UI offers retire+create instead. Allow case-only fixes.
    if (payload.name && payload.name.toLowerCase() !== existing.name.toLowerCase()) {
      throw new ValidationError('Ticket types cannot be renamed (historical tickets keep the old value). Retire this one and create a new type instead.');
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (payload.isDefault === true) {
        await tx.ticketTypeDefinition.updateMany({ where: { workspaceId: Number(workspaceId), id: { not: Number(id) } }, data: { isDefault: false } });
      }
      return tx.ticketTypeDefinition.update({ where: { id: Number(id) }, data: payload });
    });
    invalidateTicketTypeCache(workspaceId);
    logger.info(`Ticket type updated: ws${workspaceId} "${existing.name}" by ${updatedBy || 'unknown'}`);
    return updated;
  }

  /** Retire, never delete — historical tickets keep the string value. */
  async retireType(workspaceId, id, updatedBy) {
    const existing = await prisma.ticketTypeDefinition.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } });
    if (!existing) throw new NotFoundError('Ticket type not found');
    const active = await prisma.ticketTypeDefinition.count({ where: { workspaceId: Number(workspaceId), isActive: true, id: { not: Number(id) } } });
    if (active === 0) throw new ValidationError('A workspace needs at least one active ticket type');
    const updated = await prisma.ticketTypeDefinition.update({
      where: { id: Number(id) },
      data: { isActive: false, isDefault: false },
    });
    invalidateTicketTypeCache(workspaceId);
    logger.info(`Ticket type retired: ws${workspaceId} "${existing.name}" by ${updatedBy || 'unknown'}`);
    return updated;
  }

  _validatePayload(data = {}, { partial = false } = {}) {
    const out = {};
    if (data.name !== undefined || !partial) {
      const name = String(data.name ?? '').trim();
      if (!name || name.length > 40) throw new ValidationError('name is required (max 40 chars)');
      out.name = name;
    }
    if (data.description !== undefined) out.description = data.description === null || data.description === undefined ? null : String(data.description).slice(0, 4000);
    if (data.aliases !== undefined) {
      if (!Array.isArray(data.aliases)) throw new ValidationError('aliases must be an array');
      out.aliases = [...new Set(data.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
    }
    if (data.fsTypeValue !== undefined) out.fsTypeValue = data.fsTypeValue === null || data.fsTypeValue === undefined ? null : String(data.fsTypeValue).trim().slice(0, 40) || null;
    if (data.aiAssignable !== undefined) out.aiAssignable = Boolean(data.aiAssignable);
    if (data.isDefault !== undefined) out.isDefault = Boolean(data.isDefault);
    if (data.color !== undefined) {
      const color = String(data.color || 'slate').trim().toLowerCase();
      if (!COLORS.has(color)) throw new ValidationError(`color must be one of: ${[...COLORS].join(', ')}`);
      out.color = color;
    }
    if (data.abbreviation !== undefined) out.abbreviation = data.abbreviation === null || data.abbreviation === undefined ? null : String(data.abbreviation).trim().toUpperCase().slice(0, 6) || null;
    if (data.sortOrder !== undefined) out.sortOrder = Number(data.sortOrder) || 0;
    if (data.isActive !== undefined) out.isActive = Boolean(data.isActive);
    return out;
  }

  // ---------- FreshService sync / drift ----------

  /**
   * Pull the FS ticket_type form-field choices for this workspace and
   * reconcile: new choice -> auto-register (active, needs description);
   * known choice -> bump fsDetectedAt. Never deactivates (FS removals are
   * surfaced as drift via stale fsDetectedAt, not acted on).
   */
  async syncFromFreshService(workspaceId, client, fsWorkspaceId) {
    const resp = await client.client.get('/ticket_form_fields', { params: { workspace_id: Number(fsWorkspaceId) } });
    const fields = resp.data?.ticket_fields || [];
    const typeField = fields.find((f) => f.name === 'ticket_type');
    if (!typeField || !Array.isArray(typeField.choices)) {
      logger.warn(`Ticket-type FS sync: no ticket_type field for ws${workspaceId}`);
      return { detected: 0, registered: 0 };
    }
    const rows = await this.listTypes(workspaceId);
    const now = new Date();
    let registered = 0;
    for (const choice of typeField.choices) {
      const value = String(choice.value || '').trim();
      if (!value) continue;
      const match = rows.find((t) => (t.fsChoiceId !== null && t.fsChoiceId !== undefined && BigInt(t.fsChoiceId) === BigInt(choice.id)))
        || rows.find((t) => (t.fsTypeValue || t.name).toLowerCase() === value.toLowerCase());
      if (match) {
        await prisma.ticketTypeDefinition.update({
          where: { id: match.id },
          data: { fsDetectedAt: now, fsChoiceId: BigInt(choice.id), fsTypeValue: value },
        });
      } else {
        registered += 1;
        await prisma.ticketTypeDefinition.create({
          data: {
            workspaceId: Number(workspaceId),
            name: value,
            fsTypeValue: value,
            fsChoiceId: BigInt(choice.id),
            fsDetectedAt: now,
            source: 'fs_sync',
            abbreviation: value.slice(0, 4).toUpperCase(),
          },
        });
        logger.info(`Ticket-type FS sync: registered new FS type "${value}" for ws${workspaceId}`);
      }
    }
    invalidateTicketTypeCache(workspaceId);
    return { detected: typeField.choices.length, registered };
  }
}

export default new TicketTypeService();
