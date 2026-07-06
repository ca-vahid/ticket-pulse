import prisma from './prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const FIELD_TYPES = ['text', 'number', 'select', 'boolean', 'date'];
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;

/**
 * Per-workspace user-defined ticket fields (pragmatic JSON UDF): definitions
 * live in custom_field_definitions; values live in Ticket.customFields keyed
 * by definition key. TP-born tickets are editable in-app; FS-born tickets can
 * also carry TP-side custom values (they're OUR annotation layer, never
 * written back to FreshService).
 */
class CustomFieldService {
  async listDefinitions(workspaceId, { includeInactive = false } = {}) {
    return prisma.customFieldDefinition.findMany({
      where: { workspaceId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createDefinition(workspaceId, { key, label, type = 'text', options = [] }) {
    const cleanKey = String(key || '').trim().toLowerCase();
    if (!KEY_PATTERN.test(cleanKey)) {
      throw new ValidationError('Field key must be lowercase letters/numbers/underscores, starting with a letter');
    }
    if (!FIELD_TYPES.includes(type)) throw new ValidationError(`Field type must be one of: ${FIELD_TYPES.join(', ')}`);
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) throw new ValidationError('Field needs a label');
    if (type === 'select' && (!Array.isArray(options) || options.filter(Boolean).length === 0)) {
      throw new ValidationError('Select fields need at least one option');
    }
    return prisma.customFieldDefinition.create({
      data: {
        workspaceId,
        key: cleanKey,
        label: cleanLabel.slice(0, 120),
        type,
        options: type === 'select' ? options.map(String).filter(Boolean) : [],
      },
    });
  }

  async updateDefinition(workspaceId, id, { label, options, isActive, sortOrder }) {
    const definition = await prisma.customFieldDefinition.findFirst({ where: { id: Number(id), workspaceId } });
    if (!definition) throw new NotFoundError('Custom field not found');
    return prisma.customFieldDefinition.update({
      where: { id: definition.id },
      data: {
        ...(label !== undefined ? { label: String(label).trim().slice(0, 120) } : {}),
        ...(options !== undefined ? { options: (options || []).map(String).filter(Boolean) } : {}),
        ...(isActive !== undefined ? { isActive: isActive !== false } : {}),
        ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
      },
    });
  }

  async removeDefinition(workspaceId, id) {
    const definition = await prisma.customFieldDefinition.findFirst({ where: { id: Number(id), workspaceId } });
    if (!definition) throw new NotFoundError('Custom field not found');
    // Values already stored on tickets keep their key (harmless orphans);
    // deleting the definition just removes the field from forms/conditions.
    await prisma.customFieldDefinition.delete({ where: { id: definition.id } });
    return { deleted: true };
  }

  /** Validate + merge values into a ticket's customFields JSON. Unknown keys are rejected. */
  async setValues(ticketId, workspaceId, values, actor) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ValidationError('Custom field values must be an object');
    }
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId } });
    if (!ticket) throw new NotFoundError('Ticket not found in this workspace');

    const definitions = await this.listDefinitions(workspaceId);
    const byKey = new Map(definitions.map((d) => [d.key, d]));
    const merged = { ...(ticket.customFields || {}) };
    const changes = {};
    for (const [key, raw] of Object.entries(values)) {
      const definition = byKey.get(key);
      if (!definition) throw new ValidationError(`Unknown custom field "${key}"`);
      const value = coerceValue(definition, raw);
      changes[key] = { from: merged[key] ?? null, to: value };
      if (value === null) delete merged[key];
      else merged[key] = value;
    }

    await prisma.ticket.update({ where: { id: ticket.id }, data: { customFields: merged } });
    try {
      const { default: ticketActivityRepository } = await import('./ticketActivityRepository.js');
      await ticketActivityRepository.create({
        ticketId: ticket.id,
        activityType: 'custom_fields_changed',
        performedBy: actor?.name || actor?.email || 'Ticket Pulse',
        performedAt: new Date(),
        details: { changes },
      });
    } catch { /* non-fatal */ }
    return { customFields: merged, changes };
  }
}

function coerceValue(definition, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (definition.type) {
  case 'number': {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new ValidationError(`"${definition.label}" must be a number`);
    return n;
  }
  case 'boolean':
    return raw === true || String(raw).toLowerCase() === 'true';
  case 'select': {
    const v = String(raw);
    if (!definition.options.includes(v)) throw new ValidationError(`"${definition.label}" must be one of: ${definition.options.join(', ')}`);
    return v;
  }
  case 'date': {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new ValidationError(`"${definition.label}" must be a date`);
    return d.toISOString();
  }
  default:
    return String(raw).slice(0, 2000);
  }
}

const customFieldService = new CustomFieldService();
export default customFieldService;
