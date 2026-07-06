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

const MAX_TOTAL_ROWS = 20;
const MAX_DEPTH = 2; // root group + one nested level

/**
 * Field catalog — what a workflow author can match on. `path` is the
 * json-logic var path inside the engine's evaluation scope; `type` picks the
 * operator set + the value input the builder UI renders.
 */
export const CONDITION_FIELDS = Object.freeze({
  'ticket.status': { label: 'Ticket status', type: 'enum', path: 'ticket.status', options: ['Open', 'Pending', 'Resolved', 'Closed'] },
  'ticket.priorityLabel': { label: 'Priority', type: 'enum', path: 'ticket.priorityLabel', options: ['Low', 'Medium', 'High', 'Urgent'] },
  'ticket.origin': { label: 'Ticket origin', type: 'enum', path: 'ticket.origin', options: ['ticketpulse', 'freshservice'] },
  'ticket.subject': { label: 'Subject', type: 'string', path: 'ticket.subject' },
  'ticket.descriptionText': { label: 'Description', type: 'string', path: 'ticket.descriptionText' },
  'ticket.category': { label: 'Category (FS)', type: 'string', path: 'ticket.category' },
  'ticket.internalCategory': { label: 'Category', type: 'string', path: 'ticket.internalCategory.name' },
  'ticket.internalSubcategory': { label: 'Subcategory', type: 'string', path: 'ticket.internalSubcategory.name' },
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
});

export const VALUELESS_OPERATORS = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false']);

function isGroup(entry) {
  return entry && typeof entry === 'object' && Array.isArray(entry.conditions);
}

function fieldSpec(fieldKey) {
  return CONDITION_FIELDS[fieldKey] || null;
}

function compileRow(row) {
  const spec = fieldSpec(row.field);
  if (!spec) throw new Error(`Unknown condition field: ${row.field}`);
  const v = { var: spec.path };
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
  default: throw new Error(`Unknown condition operator: ${row.operator}`);
  }
}

function compileGroup(group, depth) {
  if (depth > MAX_DEPTH) throw new Error(`Condition groups can nest at most ${MAX_DEPTH - 1} level`);
  const parts = (group.conditions || []).map((entry) => (
    isGroup(entry) ? compileGroup(entry, depth + 1) : compileRow(entry)
  ));
  if (parts.length === 0) return true; // empty group matches everything
  if (parts.length === 1) return parts[0];
  return group.logic === 'any' ? { or: parts } : { and: parts };
}

/** Compile a stored condition group into a json-logic rule. Throws on invalid input. */
export function compileConditionGroup(group) {
  if (!isGroup(group)) throw new Error('Condition group must have a conditions array');
  return compileGroup(group, 1);
}

/**
 * Validate a condition group for save-time feedback. Returns a string[] of
 * problems (empty = valid). Lenient about value shapes — the compiler coerces.
 */
export function validateConditionGroup(group) {
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
    const spec = fieldSpec(entry?.field);
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
  VALUELESS_OPERATORS,
  compileConditionGroup,
  validateConditionGroup,
};
