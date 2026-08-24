import prisma from './prisma.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const FIELD_TYPES = ['text', 'number', 'select', 'boolean', 'date'];
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;

// Intake caps (FR 08-05 #1, Phase 1a) — keep a single misbehaving sender from
// flooding a workspace with definitions or bloating the Json column.
const MAX_KEYS_PER_CALL = 40;
const MAX_VALUE_CHARS = 2000;
const MAX_DEFINITIONS_PER_WORKSPACE = 200;

// A full date is the minimum; time + zone optional (ISO-8601 shapes only —
// bare numbers or "March 5" stay text).
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Normalize an incoming API key to the definition-key alphabet: camelCase →
 * snake_case, spaces/hyphens/dots → underscores, lowered, squeezed. The result
 * still has to pass KEY_PATTERN — keys that don't (digits-first, non-ASCII,
 * punctuation…) are REJECTED by setValuesAtCreate rather than mangled further.
 */
export function normalizeFieldKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // clientName → client_Name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // PONumber → PO_Number
    .replace(/[\s\-.]+/g, '_')
    .toLowerCase()
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** 'client_name' → 'Client Name' (labels for auto-provisioned definitions). */
export function prettifyKeyLabel(key) {
  return String(key)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Infer a definition type from the first value an unknown key arrives with. */
export function inferFieldType(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string' && ISO_DATE_PATTERN.test(value.trim())
    && !Number.isNaN(new Date(value.trim()).getTime())) return 'date';
  return 'text';
}

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

  async createDefinition(workspaceId, { key, label, type = 'text', options = [], isRequiredOnCreate, defaultValue }) {
    const cleanKey = String(key || '').trim().toLowerCase();
    if (!KEY_PATTERN.test(cleanKey)) {
      throw new ValidationError('Field key must be lowercase letters/numbers/underscores, starting with a letter');
    }
    if (!FIELD_TYPES.includes(type)) throw new ValidationError(`Field type must be one of: ${FIELD_TYPES.join(', ')}`);
    const cleanLabel = String(label || '').trim();
    if (!cleanLabel) throw new ValidationError('Field needs a label');
    const cleanOptions = type === 'select' ? (options || []).map(String).filter(Boolean) : [];
    if (type === 'select' && cleanOptions.length === 0) {
      throw new ValidationError('Select fields need at least one option');
    }
    return prisma.customFieldDefinition.create({
      data: {
        workspaceId,
        key: cleanKey,
        label: cleanLabel.slice(0, 120),
        type,
        options: cleanOptions,
        isRequiredOnCreate: isRequiredOnCreate === true,
        defaultValue: normalizeDefaultValue({ type, options: cleanOptions, label: cleanLabel }, defaultValue),
      },
    });
  }

  async updateDefinition(workspaceId, id, { label, type, options, isActive, sortOrder, isFeatured, isRequiredOnCreate, defaultValue }) {
    const definition = await prisma.customFieldDefinition.findFirst({ where: { id: Number(id), workspaceId } });
    if (!definition) throw new NotFoundError('Custom field not found');
    // Type is editable so admins can curate API-provisioned definitions (the
    // intake inference only sees the FIRST value — e.g. a numeric-looking id
    // lands as `number` but should be `text`). Existing ticket values keep
    // their stored shape; coercion applies from the next write.
    if (type !== undefined && !FIELD_TYPES.includes(type)) {
      throw new ValidationError(`Field type must be one of: ${FIELD_TYPES.join(', ')}`);
    }
    const nextType = type !== undefined ? type : definition.type;
    const nextOptions = options !== undefined ? (options || []).map(String).filter(Boolean) : definition.options || [];
    if (nextType === 'select' && nextOptions.length === 0) {
      throw new ValidationError('Select fields need at least one option');
    }
    const data = {
      ...(label !== undefined ? { label: String(label).trim().slice(0, 120) } : {}),
      ...(type !== undefined ? { type: nextType } : {}),
      ...(options !== undefined || type !== undefined ? { options: nextType === 'select' ? nextOptions : [] } : {}),
      ...(isActive !== undefined ? { isActive: isActive !== false } : {}),
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
      ...(isFeatured !== undefined ? { isFeatured: isFeatured === true } : {}),
      // New-ticket form (Phase TF): required binds composer + public API
      // create; defaultValue prefills the composer only (stored as a string,
      // validated against the — possibly updated — type/options).
      ...(isRequiredOnCreate !== undefined ? { isRequiredOnCreate: isRequiredOnCreate === true } : {}),
      ...(defaultValue !== undefined ? {
        defaultValue: normalizeDefaultValue(
          { type: nextType, options: nextOptions, label: label !== undefined ? String(label) : definition.label },
          defaultValue,
        ),
      } : {}),
    };
    // At most ONE featured definition per workspace (it drives the queue-row
    // chip): featuring this one unfeatures the rest, atomically.
    if (isFeatured === true) {
      const [, updated] = await prisma.$transaction([
        prisma.customFieldDefinition.updateMany({
          where: { workspaceId, isFeatured: true, id: { not: definition.id } },
          data: { isFeatured: false },
        }),
        prisma.customFieldDefinition.update({ where: { id: definition.id }, data }),
      ]);
      return updated;
    }
    return prisma.customFieldDefinition.update({ where: { id: definition.id }, data });
  }

  async removeDefinition(workspaceId, id) {
    const definition = await prisma.customFieldDefinition.findFirst({ where: { id: Number(id), workspaceId } });
    if (!definition) throw new NotFoundError('Custom field not found');
    // Values already stored on tickets keep their key (harmless orphans);
    // deleting the definition just removes the field from forms/conditions.
    await prisma.customFieldDefinition.delete({ where: { id: definition.id } });
    return { deleted: true };
  }

  /**
   * Create-time intake (FR 08-05 #1, Phase 1a): validate/coerce a values
   * object BEFORE the ticket row exists, so createTicket can write the result
   * straight into its prisma `create` data. Never throws for a bad key or
   * value — unusable entries come back in `rejected` (reason included) so the
   * caller can surface them (API response meta + created audit).
   *
   * - Keys are normalized (camelCase/spaces → snake_case) then matched against
   *   the workspace's definitions (inactive included — a retired definition
   *   still owns its key; the value is stored, nothing is re-provisioned).
   * - Unknown keys AUTO-PROVISION a definition when `autoProvision` is on:
   *   type inferred from the value, label prettified from the key,
   *   `source:'api'`, active, sorted after the existing fields.
   * - Caps: ≤40 keys/call, values ≤2000 chars stringified, ≤200
   *   definitions/workspace — everything over a cap lands in `rejected`.
   *
   * @returns {Promise<{values: object, provisioned: string[], rejected: Array<{key: string, reason: string}>}>}
   */
  async setValuesAtCreate(workspaceId, values, { autoProvision = true, actor = null } = {}) { // eslint-disable-line no-unused-vars
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ValidationError('Custom field values must be an object');
    }
    const rejected = [];
    const provisioned = [];
    const clean = {};

    // Normalize + dedupe (two spellings of the same key — 'clientName' and
    // 'client_name' — collapse to one entry; the LAST occurrence wins).
    const seen = new Map();
    const normalized = [];
    for (const [rawKey, value] of Object.entries(values)) {
      const key = normalizeFieldKey(rawKey);
      if (!KEY_PATTERN.test(key)) {
        rejected.push({ key: String(rawKey), reason: 'invalid_key' });
        continue;
      }
      if (seen.has(key)) {
        normalized[seen.get(key)] = [key, value];
        continue;
      }
      seen.set(key, normalized.length);
      normalized.push([key, value]);
    }
    while (normalized.length > MAX_KEYS_PER_CALL) {
      const [key] = normalized.pop();
      rejected.push({ key, reason: 'too_many_keys' });
    }

    const definitions = await this.listDefinitions(workspaceId, { includeInactive: true });
    const byKey = new Map(definitions.map((d) => [d.key, d]));
    let definitionCount = definitions.length;
    let nextSortOrder = definitions.reduce((max, d) => Math.max(max, d.sortOrder || 0), 0) + 1;

    for (const [key, raw] of normalized) {
      if (raw === undefined) continue;
      const stringified = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (typeof stringified === 'string' && stringified.length > MAX_VALUE_CHARS) {
        rejected.push({ key, reason: 'value_too_long' });
        continue;
      }

      let definition = byKey.get(key);
      if (!definition) {
        if (!autoProvision) {
          rejected.push({ key, reason: 'unknown_field' });
          continue;
        }
        if (definitionCount >= MAX_DEFINITIONS_PER_WORKSPACE) {
          rejected.push({ key, reason: 'definition_cap_reached' });
          continue;
        }
        try {
          definition = await prisma.customFieldDefinition.create({
            data: {
              workspaceId,
              key,
              label: prettifyKeyLabel(key),
              type: inferFieldType(raw),
              options: [],
              source: 'api',
              sortOrder: nextSortOrder++,
            },
          });
        } catch {
          // Unique race (two creates provisioning the same key) — take the row
          // the other writer won with.
          definition = await prisma.customFieldDefinition.findFirst({ where: { workspaceId, key } });
        }
        if (!definition) {
          rejected.push({ key, reason: 'provision_failed' });
          continue;
        }
        byKey.set(key, definition);
        definitionCount += 1;
        provisioned.push(key);
      }

      try {
        const value = coerceValue(definition, raw);
        if (value !== null) clean[key] = value;
      } catch (err) {
        rejected.push({ key, reason: err.message });
      }
    }

    return { values: clean, provisioned, rejected };
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

    // Outbound webhook (Custom Fields Activation Phase 2): custom-field edits
    // don't ride the lifecycle pipeline, so dispatch directly AFTER the audit
    // write — same pattern as ticket.tags_changed in ticketService.setTags.
    // Payload mirrors webhookPayloadFromContext (taxonomy NAMES + the merged
    // customFields) plus the machine-readable changedKeys list.
    const changedKeys = Object.keys(changes)
      .filter((key) => JSON.stringify(changes[key].from ?? null) !== JSON.stringify(changes[key].to ?? null));
    if (changedKeys.length) this._dispatchChangeWebhook(ticket.id, workspaceId, merged, changedKeys);

    return { customFields: merged, changes };
  }

  /** Fire-and-forget ticket.custom_fields_changed dispatch (never throws). */
  _dispatchChangeWebhook(ticketId, workspaceId, mergedValues, changedKeys) {
    try {
      this._dispatchChangeWebhookAsync(ticketId, workspaceId, mergedValues, changedKeys);
    } catch { /* integrations never break the edit */ }
  }

  _dispatchChangeWebhookAsync(ticketId, workspaceId, mergedValues, changedKeys) {
    Promise.all([
      import('./webhookDispatchService.js'),
      import('../utils/ticketOrigin.js'),
      prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true,
          origin: true,
          status: true,
          nativeNumber: true,
          freshserviceTicketId: true,
          subject: true,
          priority: true,
          internalCategory: { select: { name: true } },
          internalSubcategory: { select: { name: true } },
          tagLinks: { select: { tag: { select: { name: true } } } },
        },
      }),
    ]).then(([{ dispatchWebhookEvent }, { ticketDisplayRef }, fresh]) => {
      if (!fresh) return;
      dispatchWebhookEvent(workspaceId, 'ticket.custom_fields_changed', {
        ticket: {
          id: fresh.id,
          ref: ticketDisplayRef(fresh),
          subject: fresh.subject,
          status: fresh.status,
          priority: fresh.priority,
          origin: fresh.origin,
          tags: fresh.tagLinks.map((l) => l.tag.name).sort(),
          category: fresh.internalCategory?.name || null,
          subcategory: fresh.internalSubcategory?.name || null,
          customFields: mergedValues || {},
        },
        changedKeys,
      });
    }).catch(() => { /* integrations never break the edit */ });
  }
}

/**
 * Validate an admin-entered default value against the field's type and store
 * it as a string (the DB shape). null/'' clears the default. Reuses
 * coerceValue so a default can never be a value the field itself would reject.
 */
function normalizeDefaultValue(definition, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = coerceValue(definition, raw); // throws ValidationError on mismatch
  return value === null ? null : String(value).slice(0, 2000);
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
