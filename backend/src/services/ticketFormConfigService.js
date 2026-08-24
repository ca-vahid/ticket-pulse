import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';
import { AGENT_SELECTABLE_SOURCES, TICKET_SOURCE } from '../utils/ticketOrigin.js';

/**
 * Admin-editable new-ticket form per workspace (Mega 08-23 Phase TF).
 *
 * Scope contract (stated in the admin UI copy too): this configures the
 * TICKET PULSE composer + create validation ONLY — FreshService-owned forms
 * and fields are untouched.
 *
 * Enforcement contract (decision documented here once):
 *  - `visible` is COMPOSER-ONLY: hiding a built-in removes it from the
 *    /tickets/new form, but the API may still set it (an integration that
 *    sends `groupId` must not break because an admin de-cluttered the form).
 *  - `required` on built-ins and `isRequiredOnCreate` on custom fields bind
 *    the INTERACTIVE composer and the PUBLIC API create (both pass
 *    enforceRequired) — automated intakes (email ingest, scheduled-ticket
 *    activation, workflow child tickets, clone) cannot answer a validation
 *    error and are exempt.
 *  - requester + subject are always visible AND required (the create schema
 *    already hard-requires them; the config cannot relax that).
 */

// The FIXED built-in vocabulary, in default display order. Keys are the
// config/API surface; labels are the admin-editor display names.
export const BUILT_IN_FORM_FIELDS = [
  { key: 'requester', label: 'Requester', locked: true, requirable: false },
  { key: 'subject', label: 'Subject', locked: true, requirable: false },
  { key: 'description', label: 'Description', locked: false, requirable: true },
  { key: 'type', label: 'Type', locked: false, requirable: false },
  { key: 'priority', label: 'Priority', locked: false, requirable: false },
  { key: 'category', label: 'Category', locked: false, requirable: true },
  { key: 'subcategory', label: 'Subcategory', locked: false, requirable: true },
  { key: 'source', label: 'Source', locked: false, requirable: false },
  { key: 'group', label: 'Group', locked: false, requirable: true },
  { key: 'tags', label: 'Tags', locked: false, requirable: true },
  { key: 'cc', label: 'Cc', locked: false, requirable: true },
  { key: 'attachments', label: 'Attachments', locked: false, requirable: true },
];

export const BUILT_IN_FIELD_KEYS = BUILT_IN_FORM_FIELDS.map((f) => f.key);
const BY_KEY = new Map(BUILT_IN_FORM_FIELDS.map((f) => [f.key, f]));

// `priority` and `type` always resolve a value server-side (schema default 2 /
// workspace default type), so "required" would be meaningless — their rows are
// requirable:false. `attachments` required is COMPOSER-ONLY by nature (files
// upload AFTER create; the server never sees them in the create payload).
const COMPOSER_ONLY_REQUIRED = new Set(['attachments']);

// Per-field default-value support: which keys accept a stored defaultValue
// and how the composer interprets it. priority → '1'..'4'; type → a type
// name (validated lazily against the registry at composer render).
const DEFAULTABLE_KEYS = new Set(['priority', 'type']);

export const DEFAULT_FORM_DEFAULTS = {
  notifyRequester: true,
  aiClassify: true,
  // 'none' matches what the composer actually CREATED with historically (the
  // initial useState) — resetForm's stray 'ai' was the bug, not the intent.
  assignMode: 'none',
};
const ASSIGN_MODES = ['ai', 'none'];

function defaultFields() {
  return BUILT_IN_FORM_FIELDS.map((f, i) => ({
    key: f.key,
    visible: true,
    required: f.locked, // requester + subject
    defaultValue: null,
    sortOrder: i,
  }));
}

/**
 * Validate + canonicalize a `fields` payload. Unknown keys are REJECTED (the
 * vocabulary is fixed); missing keys are filled in with their defaults so the
 * stored array is always complete; requester/subject are forced
 * visible+required. Returns the canonical array sorted by sortOrder.
 */
export function normalizeFields(input) {
  if (input === null || input === undefined) return defaultFields();
  if (!Array.isArray(input)) throw new ValidationError('fields must be an array');
  const seen = new Set();
  const rows = [];
  for (const raw of input) {
    const key = String(raw?.key ?? '');
    const spec = BY_KEY.get(key);
    if (!spec) {
      throw new ValidationError(`Unknown form field "${key}". Valid fields: ${BUILT_IN_FIELD_KEYS.join(', ')}`);
    }
    if (seen.has(key)) throw new ValidationError(`Duplicate form field "${key}"`);
    seen.add(key);
    let defaultValue = raw?.defaultValue ?? null;
    if (defaultValue !== null) {
      defaultValue = String(defaultValue).slice(0, 200);
      if (!DEFAULTABLE_KEYS.has(key)) defaultValue = null;
      else if (key === 'priority' && !['1', '2', '3', '4'].includes(defaultValue)) {
        throw new ValidationError('priority defaultValue must be "1"–"4"');
      }
    }
    const visible = spec.locked ? true : raw?.visible !== false;
    rows.push({
      key,
      visible,
      // A hidden field can never be required: the composer couldn't satisfy
      // it (and the server enforces the same config on the composer's own
      // create call). Hiding a required field silently drops the requirement.
      required: spec.locked ? true : (spec.requirable && visible ? raw?.required === true : false),
      defaultValue,
      sortOrder: Number.isFinite(Number(raw?.sortOrder)) ? Number(raw.sortOrder) : rows.length,
    });
  }
  // Fill in anything the payload left out (partial saves stay total).
  for (const [i, spec] of BUILT_IN_FORM_FIELDS.entries()) {
    if (!seen.has(spec.key)) {
      rows.push({ key: spec.key, visible: true, required: spec.locked, defaultValue: null, sortOrder: BUILT_IN_FORM_FIELDS.length + i });
    }
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder);
  return rows.map((r, i) => ({ ...r, sortOrder: i }));
}

function normalizeDefaults(input) {
  if (input === null || input === undefined) return { ...DEFAULT_FORM_DEFAULTS };
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('defaults must be an object');
  const assignMode = input.assignMode ?? DEFAULT_FORM_DEFAULTS.assignMode;
  if (!ASSIGN_MODES.includes(assignMode)) {
    throw new ValidationError(`defaults.assignMode must be one of: ${ASSIGN_MODES.join(', ')}`);
  }
  return {
    notifyRequester: input.notifyRequester !== false,
    aiClassify: input.aiClassify !== false,
    assignMode,
  };
}

class TicketFormConfigService {
  /** Raw config row (or null). Never throws — pre-migration DBs read as "no row". */
  async getConfig(workspaceId) {
    try {
      return await prisma.ticketFormConfig.findUnique({ where: { workspaceId } });
    } catch {
      return null;
    }
  }

  /**
   * Resolved form for meta delivery / create enforcement. `workspace` (with
   * defaultInternalGroupId) is optional — pass the already-fetched row to
   * avoid a second query.
   *
   * Shape: {
   *   fields: [{key, label, visible, required, defaultValue, sortOrder, locked}],
   *   defaultSource: int,
   *   defaultGroup: {kind:'fs'|'internal', id:string}|null,
   *   defaults: {notifyRequester, aiClassify, assignMode},
   * }
   */
  resolve(config, workspace = null) {
    let fields;
    let defaults;
    try {
      fields = normalizeFields(config?.fields ?? null);
      defaults = normalizeDefaults(config?.defaults ?? null);
    } catch {
      // Stored garbage (manual DB edits) must not break the composer.
      fields = defaultFields();
      defaults = { ...DEFAULT_FORM_DEFAULTS };
    }
    const defaultSource = AGENT_SELECTABLE_SOURCES.includes(Number(config?.defaultSource))
      ? Number(config.defaultSource)
      : TICKET_SOURCE.AGENT;
    // Composer group preselect: a configured FS group wins; otherwise SURFACE
    // the workspace's default internal group (which createTicket already
    // applies silently when the caller sends no group — QA 08-06 #1).
    let defaultGroup = null;
    if (config?.defaultGroupId !== null && config?.defaultGroupId !== undefined) {
      defaultGroup = { kind: 'fs', id: String(config.defaultGroupId) };
    } else if (workspace?.defaultInternalGroupId !== null && workspace?.defaultInternalGroupId !== undefined) {
      defaultGroup = { kind: 'internal', id: String(workspace.defaultInternalGroupId) };
    }
    return {
      fields: fields.map((f) => ({
        ...f,
        label: BY_KEY.get(f.key)?.label || f.key,
        locked: BY_KEY.get(f.key)?.locked === true,
      })),
      defaultSource,
      defaultGroup,
      defaults,
    };
  }

  async getResolvedForm(workspaceId, workspace = null) {
    const config = await this.getConfig(workspaceId);
    let ws = workspace;
    if (!ws) {
      try {
        ws = await prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { defaultInternalGroupId: true },
        });
      } catch { ws = null; }
    }
    return this.resolve(config, ws);
  }

  /**
   * Admin upsert. `reset: true` deletes the row (back to defaults). Partial
   * bodies only touch the keys they carry.
   */
  async update(workspaceId, body = {}, actorEmail = null) {
    if (body.reset === true) {
      try {
        await prisma.ticketFormConfig.delete({ where: { workspaceId } });
      } catch { /* no row — already default */ }
      return this.getResolvedForm(workspaceId);
    }

    const data = {};
    if (body.fields !== undefined) data.fields = normalizeFields(body.fields);
    if (body.defaultSource !== undefined) {
      if (body.defaultSource === null) data.defaultSource = null;
      else {
        const src = Number(body.defaultSource);
        if (!AGENT_SELECTABLE_SOURCES.includes(src)) {
          throw new ValidationError(`defaultSource must be one of the selectable arrival channels (${AGENT_SELECTABLE_SOURCES.join(', ')})`);
        }
        data.defaultSource = src;
      }
    }
    if (body.defaultGroupId !== undefined) {
      if (body.defaultGroupId === null || body.defaultGroupId === '') data.defaultGroupId = null;
      else {
        const raw = String(body.defaultGroupId);
        if (!/^\d+$/.test(raw)) throw new ValidationError('defaultGroupId must be a FreshService group id');
        const group = await prisma.group.findFirst({
          where: { workspaceId, freshserviceId: BigInt(raw), isActive: true },
          select: { id: true },
        });
        if (!group) throw new ValidationError('defaultGroupId does not match an active FreshService group in this workspace');
        data.defaultGroupId = BigInt(raw);
      }
    }
    if (body.defaults !== undefined) {
      data.defaults = body.defaults === null ? null : normalizeDefaults(body.defaults);
    }
    if (!Object.keys(data).length) throw new ValidationError('Nothing to update');
    data.updatedBy = actorEmail;

    await prisma.ticketFormConfig.upsert({
      where: { workspaceId },
      update: data,
      create: { workspaceId, ...data },
    });
    return this.getResolvedForm(workspaceId);
  }

  /**
   * Create-time required enforcement (interactive composer + public API only
   * — see the contract at the top). `data` is the PARSED create payload;
   * throws ValidationError listing every missing required field at once.
   */
  assertRequiredBuiltIns(resolvedForm, data) {
    const missing = [];
    for (const field of resolvedForm.fields) {
      if (!field.required || BY_KEY.get(field.key)?.locked) continue;
      if (COMPOSER_ONLY_REQUIRED.has(field.key)) continue;
      const empty = {
        description: () => !String(data.description || '').trim(),
        category: () => data.internalCategoryId === null || data.internalCategoryId === undefined,
        subcategory: () => data.internalSubcategoryId === null || data.internalSubcategoryId === undefined,
        source: () => data.source === null || data.source === undefined,
        group: () => (data.groupId === null || data.groupId === undefined)
          && (data.internalGroupId === null || data.internalGroupId === undefined),
        tags: () => !Array.isArray(data.tagIds) || data.tagIds.length === 0,
        cc: () => !Array.isArray(data.ccEmails) || data.ccEmails.length === 0,
      }[field.key];
      if (!empty || !empty()) continue;
      // AI-owned fields: when the create runs AI classification the category
      // tree is the model's to fill — requiring it up front would make the
      // "AI decides" flow impossible.
      if ((field.key === 'category' || field.key === 'subcategory') && (data.runAiTriage || data.aiClassifyOnly)) continue;
      missing.push(field.label);
    }
    if (missing.length) {
      throw new ValidationError(`Required by this workspace's ticket form: ${missing.join(', ')}`);
    }
  }
}

const ticketFormConfigService = new TicketFormConfigService();
export default ticketFormConfigService;
