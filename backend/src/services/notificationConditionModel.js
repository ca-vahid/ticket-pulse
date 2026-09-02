/**
 * Structured condition model for notification workflows.
 *
 * The universal primitive every working rule builder uses (Zendesk, Jira,
 * Make, n8n): a `{ field, operator, value }` row, grouped under an ALL/ANY
 * selector, nestable exactly ONE level (a group of groups) with hard caps so
 * rules stay legible. Groups are stored declaratively on the condition node
 * (`node.data.conditionGroup`) and compiled to json-logic at evaluation time,
 * so the engine's existing evaluator is reused unchanged and saved
 * definitions never contain stale compiled output.
 *
 * Shape:
 *   { logic: 'all' | 'any', conditions: [ Row | Group ] }
 *   Row: { field: '<catalog key>', operator: '<op>', value?: any }
 */

import { BUILTIN_CHANGE_FIELDS, EVENT_ACTOR_KINDS } from './ticketChangeRenderer.js';

const MAX_TOTAL_ROWS = 20;
const MAX_DEPTH = 2; // root group + one nested level

/**
 * Field catalog — what a workflow author can match on. `path` is the
 * json-logic var path inside the engine's evaluation scope; `type` picks the
 * operator set + the value input the builder UI renders.
 */
export const CONDITION_FIELDS = Object.freeze({
  // Ticket status is per-workspace since Phase 8a (statusService registry).
  // `options` stays the canonical 4 as a static fallback; `dynamicOptions`
  // is the 8c hook point — the builder UI should fetch the workspace's
  // statuses (GET /api/ticket-statuses) and use them instead of `options`.
  // Values are NOT validated against `options` (validateConditionGroup is
  // value-lenient), so custom statuses already evaluate correctly today.
  'ticket.status': { label: 'Ticket status', type: 'enum', path: 'ticket.status', options: ['Open', 'Pending', 'Resolved', 'Closed'], dynamicOptions: 'ticket-statuses' },
  // Derived base (Phase 8c): every status label maps to one of the 4 canonical
  // bases via the workspace registry, so "any open-base status" is matchable
  // without enumerating custom labels. Populated on the event context by
  // ticketLifecycleNotificationService / the engine's statusBase enrichment.
  'ticket.statusBase': { label: 'Ticket status base', type: 'enum', path: 'ticket.statusBase', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
  'ticket.priorityLabel': { label: 'Priority', type: 'enum', path: 'ticket.priorityLabel', options: ['Low', 'Medium', 'High', 'Urgent'] },
  'ticket.origin': { label: 'Ticket origin', type: 'enum', path: 'ticket.origin', options: ['ticketpulse', 'freshservice'] },
  // How the ticket came to exist (Phase RL, RL-6): app form, inbound email,
  // public API, FreshService sync-in, a hold-queue "Create ticket", an
  // agent's reply-all with the mailbox in Cc, or a forwarded email. Lets a
  // "Ticket arrived" ack skip FS sync-ins and hold-queue resolutions.
  'ticket.createdVia': { label: 'Created via', type: 'enum', path: 'ticket.createdVia', options: ['app', 'email', 'api', 'freshservice_sync', 'held_reply', 'agent_cc', 'forward'] },
  // Arrival channel (QA 07-07 #1) — how the ticket reached the helpdesk.
  'ticket.sourceLabel': { label: 'Ticket source', type: 'enum', path: 'ticket.sourceLabel', options: ['Email', 'Portal', 'Phone', 'Chat', 'API', 'Webhook', 'Agent'] },
  // Ticket type — per-workspace vocabulary (registry-driven), so the builder
  // treats it as free text; the UI offers the workspace's types as hints.
  'ticket.ticketType': { label: 'Ticket type', type: 'string', path: 'ticket.ticketType' },
  'ticket.subject': { label: 'Subject', type: 'string', path: 'ticket.subject' },
  'ticket.descriptionText': { label: 'Description', type: 'string', path: 'ticket.descriptionText' },
  'ticket.category': { label: 'Category (FS)', type: 'string', path: 'ticket.category' },
  'ticket.internalCategory': { label: 'Category', type: 'string', path: 'ticket.internalCategory.name' },
  'ticket.internalSubcategory': { label: 'Subcategory', type: 'string', path: 'ticket.internalSubcategory.name' },
  'ticket.tags': { label: 'Tags', type: 'list', path: 'ticket.tags' },
  'ticket.impact': { label: 'Impact (1-3)', type: 'number', path: 'ticket.impact' },
  'ticket.urgency': { label: 'Urgency (1-3)', type: 'number', path: 'ticket.urgency' },
  // Requester sentiment (gap plan 2 P5.1) — the requester's state, team-safe.
  'ticket.sentiment': { label: 'Requester sentiment', type: 'enum', path: 'ticket.sentiment', options: ['positive', 'neutral', 'frustrated'] },
  'ticket.isNoise': { label: 'Is noise/spam', type: 'boolean', path: 'ticket.isNoise' },
  'ticket.ageMinutes': { label: 'Ticket age', type: 'duration', path: 'ticket.ageMinutes' },
  'ticket.dueInMinutes': { label: 'Time until due', type: 'duration', path: 'ticket.dueInMinutes' },
  'ticket.frDueInMinutes': { label: 'Time until first-response due', type: 'duration', path: 'ticket.frDueInMinutes' },
  'assignedAgent.email': { label: 'Assigned agent email', type: 'string', path: 'assignedAgent.email' },
  'assignedAgent.name': { label: 'Assigned agent name', type: 'string', path: 'assignedAgent.name' },
  'requester.email': { label: 'Requester email', type: 'string', path: 'requester.email' },
  'requester.department': { label: 'Requester department', type: 'string', path: 'requester.department' },
  'requester.officeLocation': { label: 'Requester office', type: 'string', path: 'requester.officeLocation' },
  'requester.city': { label: 'Requester city', type: 'string', path: 'requester.city' },
  'event.statusFrom': { label: 'Status changed from', type: 'string', path: 'event.extra.from' },
  'event.statusTo': { label: 'Status changed to', type: 'string', path: 'event.extra.to' },
  // Event provenance flags (MEGA 09-01). Absent = false ("is false" passes),
  // so workflows built before these fields keep evaluating unchanged.
  //  - systemNote: the note_added entry was machine-written (API resubmission diff …)
  //  - senderIsAgent / isSurveyResponse: reply_received provenance from the FS
  //    conversation sync — the emitter already filters both out, the fields
  //    make the seeded reopen workflow's guard VISIBLE to admins.
  'event.systemNote': { label: 'Note was written by the system', type: 'boolean', path: 'event.extra.systemNote' },
  // "Ticket updated (fields)" payload (MEGA 09-01 Phase TU, TU-7). Options
  // for changedFields = built-in field keys + this workspace's custom-field
  // keys as `customFields.<key>` (the /condition-fields route resolves
  // `dynamicOptions: 'changed-fields'` the way it does ticket statuses).
  'event.changedFields': { label: 'Changed fields', type: 'list', path: 'event.extra.changedFields', options: [...BUILTIN_CHANGE_FIELDS], dynamicOptions: 'changed-fields' },
  'event.actorKind': { label: 'Updated by (kind)', type: 'enum', path: 'event.extra.actorKind', options: [...EVENT_ACTOR_KINDS] },
  'event.source': { label: 'Update source', type: 'string', path: 'event.extra.source' },
  'event.changedCount': { label: 'Changed field count', type: 'number', path: 'event.extra.changedCount' },
  'event.reopened': { label: 'Reopened by this update', type: 'boolean', path: 'event.extra.reopened' },
  'event.senderIsAgent': { label: 'Reply sender is an agent', type: 'boolean', path: 'event.extra.senderIsAgent' },
  'event.isSurveyResponse': { label: 'Reply is a survey response', type: 'boolean', path: 'event.extra.isSurveyResponse' },
  'availability.isBusinessHours': { label: 'During business hours', type: 'boolean', path: 'availability.isBusinessHours' },
  'availability.isAfterHours': { label: 'After hours', type: 'boolean', path: 'availability.isAfterHours' },
  'availability.isHoliday': { label: 'On a holiday', type: 'boolean', path: 'availability.isHoliday' },
  'workspace.name': { label: 'Workspace', type: 'string', path: 'workspace.name' },
});

/** Operators per field type. `value: false` = operator takes no value input. */
export const CONDITION_OPERATORS = Object.freeze({
  string: ['is', 'is_not', 'contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty', 'matches_regex'],
  enum: ['is', 'is_not', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
  duration: ['gt', 'lt', 'gte', 'lte'],
  number: ['is', 'is_not', 'gt', 'lt', 'gte', 'lte'],
  // Date-typed custom fields (FR 08-05 Phase 1b): point-in-time comparisons.
  date: ['before', 'after', 'is_empty', 'is_not_empty'],
  // Array-valued fields (e.g. ticket.tags): membership tests over the list.
  list: ['has_any', 'has_all', 'has_none', 'is_empty', 'is_not_empty'],
});

export const VALUELESS_OPERATORS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);

/**
 * CustomFieldDefinition.type → condition field type (FR 08-05 Phase 1b).
 * Unknown/absent definitions fall back to 'string' so pre-typed workflows and
 * orphaned keys keep evaluating exactly as before.
 */
export const CUSTOM_FIELD_CONDITION_TYPES = Object.freeze({
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'date',
  select: 'enum',
});

/**
 * Coercion ops for typed custom-field conditions. Custom-field values arrive
 * from arbitrary API senders, so BOTH sides of a comparison must be coerced
 * consistently ("1500" > 1000, ISO strings vs date pickers). Missing or
 * unparseable values coerce to NaN, which no comparison matches — a typed
 * condition on an absent field fails closed instead of accidentally matching.
 * Registered on the engine's json-logic instance (tests mirror via this same
 * export so compile→evaluate parity lives in one module).
 */
export function registerCustomFieldConditionOps(jsonLogicInstance) {
  jsonLogicInstance.add_operation('cf_number', (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  });
  jsonLogicInstance.add_operation('cf_epoch', (v) => {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? NaN : t;
  });
  // Mirrors customFieldService.coerceValue's boolean coercion.
  jsonLogicInstance.add_operation('cf_bool', (v) => v === true || String(v).toLowerCase() === 'true');
}

function isGroup(entry) {
  return entry && typeof entry === 'object' && Array.isArray(entry.conditions);
}

/** Does any row in the group target a `custom:<key>` field? (Cheap pre-check
 * so callers only load custom-field definitions when they matter.) */
export function groupReferencesCustomFields(group) {
  if (!isGroup(group)) return false;
  return group.conditions.some((entry) => (
    isGroup(entry)
      ? groupReferencesCustomFields(entry)
      : String(entry?.field || '').startsWith('custom:')
  ));
}

function fieldSpec(fieldKey, customFieldTypes = null) {
  const key = String(fieldKey || '');
  // Dynamic user-defined ticket fields: `custom:<key>` resolves to the value
  // stored in Ticket.customFields. When the caller supplies the workspace's
  // definition types ({ key: 'number' | 'date' | … }), the field is TYPED —
  // numeric/date/boolean operators become available and evaluation coerces
  // both sides. Without types (or for unknown keys) it stays a string field.
  const customMatch = key.match(/^custom:([a-z][a-z0-9_]{1,59})$/);
  if (customMatch) {
    const defType = customFieldTypes ? customFieldTypes[customMatch[1]] : null;
    const type = CUSTOM_FIELD_CONDITION_TYPES[defType]
      || (CONDITION_OPERATORS[defType] ? defType : 'string');
    return { label: `Custom: ${customMatch[1]}`, type, path: `ticket.customFields.${customMatch[1]}`, custom: true };
  }
  return CONDITION_FIELDS[key] || null;
}

/** Typed compile for custom-field rows — returns null when the operator isn't
 * one this type coerces, letting the generic (string-semantics) switch run. */
function compileTypedCustomRow(spec, v, row) {
  const value = row.value;
  if (spec.type === 'number') {
    const n = { cf_number: [v] };
    switch (row.operator) {
    case 'is': return { '==': [n, Number(value)] };
    case 'is_not': return { '!=': [n, Number(value)] };
    case 'gt': return { '>': [n, Number(value)] };
    case 'lt': return { '<': [n, Number(value)] };
    case 'gte': return { '>=': [n, Number(value)] };
    case 'lte': return { '<=': [n, Number(value)] };
    default: return null;
    }
  }
  if (spec.type === 'date') {
    const t = { cf_epoch: [v] };
    const target = Date.parse(String(value ?? ''));
    switch (row.operator) {
    case 'before': return { '<': [t, target] };
    case 'after': return { '>': [t, target] };
    default: return null;
    }
  }
  if (spec.type === 'boolean') {
    switch (row.operator) {
    case 'is_true': return { '==': [{ cf_bool: [v] }, true] };
    case 'is_false': return { '==': [{ cf_bool: [v] }, false] };
    default: return null;
    }
  }
  return null;
}

function compileRow(row, customFieldTypes = null) {
  const spec = fieldSpec(row.field, customFieldTypes);
  if (!spec) throw new Error(`Unknown condition field: ${row.field}`);
  const v = { var: spec.path };
  if (spec.custom) {
    const typed = compileTypedCustomRow(spec, v, row);
    if (typed) return typed;
  }
  const value = row.value;
  switch (row.operator) {
  case 'is': return { '==': [v, value] };
  case 'is_not': return { '!=': [v, value] };
    // json-logic `in` doubles as substring test when the haystack is a string.
  case 'contains': return { in: [value, v] };
  case 'not_contains': return { '!': { in: [value, v] } };
  case 'in': return { in: [v, Array.isArray(value) ? value : [value]] };
  case 'not_in': return { '!': { in: [v, Array.isArray(value) ? value : [value]] } };
  case 'is_empty': return { '!': v };
  case 'is_not_empty': return { '!!': v };
  case 'is_true': return { '==': [v, true] };
  case 'is_false': return { '!=': [v, true] };
  case 'gt': return { '>': [v, Number(value)] };
  case 'lt': return { '<': [v, Number(value)] };
  case 'gte': return { '>=': [v, Number(value)] };
  case 'lte': return { '<=': [v, Number(value)] };
    // Custom op registered by the engine (json-logic has no regex built-in).
  case 'matches_regex': return { regex_match: [v, String(value ?? '')] };
    // List membership (custom engine ops; values compared case-insensitively).
  case 'has_any': return { list_has_any: [v, Array.isArray(value) ? value : [value]] };
  case 'has_all': return { list_has_all: [v, Array.isArray(value) ? value : [value]] };
  case 'has_none': return { '!': { list_has_any: [v, Array.isArray(value) ? value : [value]] } };
  default: throw new Error(`Unknown condition operator: ${row.operator}`);
  }
}

function compileGroup(group, depth, customFieldTypes) {
  if (depth > MAX_DEPTH) throw new Error(`Condition groups can nest at most ${MAX_DEPTH - 1} level`);
  const parts = (group.conditions || []).map((entry) => (
    isGroup(entry) ? compileGroup(entry, depth + 1, customFieldTypes) : compileRow(entry, customFieldTypes)
  ));
  if (parts.length === 0) return true; // empty group matches everything
  if (parts.length === 1) return parts[0];
  return group.logic === 'any' ? { or: parts } : { and: parts };
}

/**
 * Compile a stored condition group into a json-logic rule. Throws on invalid
 * input. `options.customFieldTypes` ({ key → CustomFieldDefinition.type })
 * types `custom:<key>` rows so their comparisons coerce (FR 08-05 Phase 1b).
 */
export function compileConditionGroup(group, { customFieldTypes = null } = {}) {
  if (!isGroup(group)) throw new Error('Condition group must have a conditions array');
  return compileGroup(group, 1, customFieldTypes);
}

/**
 * Validate a condition group for save-time feedback. Returns a string[] of
 * problems (empty = valid). Lenient about value shapes — the compiler coerces.
 */
export function validateConditionGroup(group, { customFieldTypes = null } = {}) {
  const errors = [];
  let rowCount = 0;

  const walk = (entry, depth, path) => {
    if (isGroup(entry)) {
      if (depth > MAX_DEPTH) {
        errors.push(`${path}: groups can nest at most ${MAX_DEPTH - 1} level deep`);
        return;
      }
      if (!['all', 'any'].includes(entry.logic)) {
        errors.push(`${path}: group logic must be "all" or "any"`);
      }
      entry.conditions.forEach((child, i) => walk(child, depth + 1, `${path}.${i}`));
      return;
    }
    rowCount += 1;
    const spec = fieldSpec(entry?.field, customFieldTypes);
    if (!spec) {
      errors.push(`${path}: unknown field "${entry?.field}"`);
      return;
    }
    const allowed = CONDITION_OPERATORS[spec.type] || [];
    if (!allowed.includes(entry.operator)) {
      errors.push(`${path}: operator "${entry.operator}" is not valid for ${spec.type} field "${entry.field}"`);
    }
    if (!VALUELESS_OPERATORS.has(entry.operator)
      && (entry.value === undefined || entry.value === null || entry.value === '')) {
      errors.push(`${path}: operator "${entry.operator}" needs a value`);
    }
    if (entry.operator === 'matches_regex') {
      try { RegExp(String(entry.value ?? '')); } catch { errors.push(`${path}: invalid regular expression`); }
    }
  };

  if (!isGroup(group)) return ['Condition group must have a conditions array'];
  walk(group, 1, 'conditions');
  if (rowCount > MAX_TOTAL_ROWS) errors.push(`Too many conditions (${rowCount} > ${MAX_TOTAL_ROWS})`);
  return errors;
}

export default {
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  CUSTOM_FIELD_CONDITION_TYPES,
  VALUELESS_OPERATORS,
  compileConditionGroup,
  validateConditionGroup,
  groupReferencesCustomFields,
  registerCustomFieldConditionOps,
};
