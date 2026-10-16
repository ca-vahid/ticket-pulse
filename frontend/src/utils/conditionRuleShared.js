/**
 * Workflow conditions without code (14 Oct 2026) — SHARED MODULE.
 *
 * Two byte-identical copies live in the repo:
 *   backend/src/services/conditionRuleShared.js
 *   frontend/src/utils/conditionRuleShared.js
 * A backend test (conditionRuleShared.test.js) fails when they differ, and
 * checks RULE_FIELDS against notificationConditionModel's CONDITION_FIELDS.
 * Edit one, copy it over the other. No imports: pure data + pure functions.
 *
 * What it holds:
 *   - ruleToConditionGroup(rule): a raw json-logic `rule` (the old "Advanced
 *     JSONLogic Rule" textarea) turned into builder rows, or null when it can
 *     not be done without changing what the step does.
 *   - conditionSwitchStop(data, scope): the step switches the engine checks
 *     before the conditions (Skip noise, Ignore Auto-help thanks).
 *   - describeConditionStep(data): one plain sentence of what a step checks.
 */

/**
 * key -> [json-logic path, field type, sentence noun, yes phrase, no phrase].
 * Path and type MUST match CONDITION_FIELDS in notificationConditionModel.js
 * (tested). The noun reads after "Continues when"; boolean fields use the
 * yes / no phrases instead of "is true".
 */
const FIELD_ROWS = [
  ['ticket.status', 'ticket.status', 'enum', 'the ticket status'],
  ['ticket.statusBase', 'ticket.statusBase', 'enum', 'the ticket status base'],
  ['ticket.priorityLabel', 'ticket.priorityLabel', 'enum', 'the priority'],
  ['ticket.origin', 'ticket.origin', 'enum', 'the ticket origin'],
  ['ticket.createdVia', 'ticket.createdVia', 'enum', 'the way the ticket was created'],
  ['ticket.sourceLabel', 'ticket.sourceLabel', 'enum', 'the ticket source'],
  ['ticket.ticketType', 'ticket.ticketType', 'string', 'the ticket type'],
  ['ticket.subject', 'ticket.subject', 'string', 'the subject'],
  ['ticket.descriptionText', 'ticket.descriptionText', 'string', 'the description'],
  ['ticket.category', 'ticket.category', 'string', 'the FreshService category'],
  ['ticket.internalCategory', 'ticket.internalCategory.name', 'string', 'the category'],
  ['ticket.internalSubcategory', 'ticket.internalSubcategory.name', 'string', 'the subcategory'],
  ['ticket.tags', 'ticket.tags', 'list', 'the tags'],
  ['ticket.impact', 'ticket.impact', 'number', 'the impact'],
  ['ticket.urgency', 'ticket.urgency', 'number', 'the urgency'],
  ['ticket.sentiment', 'ticket.sentiment', 'enum', 'the requester sentiment'],
  ['ticket.isNoise', 'ticket.isNoise', 'boolean', 'noise', 'the ticket is noise or spam', 'the ticket is not noise or spam'],
  ['ticket.isParked', 'ticket.isParked', 'boolean', 'parked', 'the ticket is parked', 'the ticket is not parked'],
  ['ticket.parkKind', 'ticket.parkKind', 'enum', 'the park kind'],
  ['ticket.resolvedByKind', 'ticket.resolvedByKind', 'enum', 'who resolved the ticket'],
  ['ticket.autoHelp.state', 'ticket.autoHelp.state', 'enum', 'the Auto-help state'],
  ['ticket.autoHelp.expected', 'ticket.autoHelp.expected', 'boolean', 'Auto-help expected', 'Auto-help will answer by itself', 'Auto-help will not answer by itself'],
  ['ticket.autoHelp.mode', 'ticket.autoHelp.mode', 'enum', 'the Auto-help mode'],
  ['ticket.autoHelp.playbook', 'ticket.autoHelp.playbook', 'string', 'the Auto-help playbook'],
  ['ticket.autoHelp.outcome', 'ticket.autoHelp.outcome', 'enum', 'the Auto-help outcome'],
  ['ticket.ageMinutes', 'ticket.ageMinutes', 'duration', 'the ticket age'],
  ['ticket.dueInMinutes', 'ticket.dueInMinutes', 'duration', 'the time until due'],
  ['ticket.frDueInMinutes', 'ticket.frDueInMinutes', 'duration', 'the time until first response is due'],
  ['ticket.lastRequesterReplyMinutes', 'ticket.lastRequesterReplyMinutes', 'duration', 'the time since the requester last wrote'],
  ['ticket.lastAgentReplyMinutes', 'ticket.lastAgentReplyMinutes', 'duration', 'the time since an agent last replied'],
  ['assignedAgent.email', 'assignedAgent.email', 'string', 'the assigned agent\'s e-mail'],
  ['assignedAgent.name', 'assignedAgent.name', 'string', 'the assigned agent'],
  ['requester.email', 'requester.email', 'string', 'the requester\'s e-mail'],
  ['requester.department', 'requester.department', 'string', 'the requester\'s department'],
  ['requester.officeLocation', 'requester.officeLocation', 'string', 'the requester\'s office'],
  ['requester.city', 'requester.city', 'string', 'the requester\'s city'],
  ['requester.onStraightTalkList', 'requester.onStraightTalkList', 'boolean', 'Straight-Talk List', 'the requester is on the Straight-Talk List', 'the requester is not on the Straight-Talk List'],
  ['event.statusFrom', 'event.extra.from', 'string', 'the old status'],
  ['event.statusTo', 'event.extra.to', 'string', 'the new status'],
  ['event.systemNote', 'event.extra.systemNote', 'boolean', 'system note', 'the note was written by the system', 'the note was not written by the system'],
  ['event.changedFields', 'event.extra.changedFields', 'list', 'the changed fields'],
  ['event.actorKind', 'event.extra.actorKind', 'enum', 'the kind of editor'],
  ['event.source', 'event.extra.source', 'string', 'the update source'],
  ['event.changedCount', 'event.extra.changedCount', 'number', 'the number of changed fields'],
  ['event.reopened', 'event.extra.reopened', 'boolean', 'reopened', 'this update reopened the ticket', 'this update did not reopen the ticket'],
  ['event.senderIsAgent', 'event.extra.senderIsAgent', 'boolean', 'agent sender', 'the reply came from an agent', 'the reply did not come from an agent'],
  ['event.isSurveyResponse', 'event.extra.isSurveyResponse', 'boolean', 'survey response', 'the reply is a survey response', 'the reply is not a survey response'],
  ['event.intakeProvisional', 'event.extra.provisional', 'boolean', 'provisional intake', 'the intake verdict is provisional', 'the intake verdict is final'],
  ['event.intakeDecision', 'event.extra.decision', 'enum', 'the intake decision'],
  ['event.intakeNonActionable', 'event.extra.nonActionable', 'boolean', 'not actionable', 'intake judged the ticket not actionable', 'intake judged the ticket actionable'],
  ['event.intakeSource', 'event.extra.source', 'enum', 'who settled the intake'],
  ['event.readyReason', 'event.extra.readyReason', 'enum', 'the reason the ticket is ready'],
  ['event.autoHelpAnswered', 'event.extra.autoHelpAnswered', 'boolean', 'Auto-help answered', 'Auto-help answered the requester', 'Auto-help did not answer the requester'],
  ['event.autoHelpReplyVerdict', 'event.extra.autoHelpReplyVerdict', 'enum', 'the reply after an Auto-help close'],
  ['event.replyVerdict', 'event.extra.replyVerdict', 'enum', 'how the reply reads'],
  ['availability.isBusinessHours', 'availability.isBusinessHours', 'boolean', 'business hours', 'it is business hours', 'it is outside business hours'],
  ['availability.isAfterHours', 'availability.isAfterHours', 'boolean', 'after hours', 'it is after hours', 'it is not after hours'],
  ['availability.isHoliday', 'availability.isHoliday', 'boolean', 'holiday', 'it is a holiday', 'it is not a holiday'],
  ['workspace.name', 'workspace.name', 'string', 'the workspace'],
];

export const RULE_FIELDS = Object.freeze(Object.fromEntries(FIELD_ROWS.map(([key, path, type, noun, yes, no]) => [
  key, Object.freeze({ path, type, noun, ...(yes ? { yes, no } : {}) }),
])));

/** Operators per field type (mirror of CONDITION_OPERATORS, tested). */
export const RULE_OPERATORS = Object.freeze({
  string: ['is', 'is_not', 'contains', 'not_contains', 'in', 'not_in', 'is_empty', 'is_not_empty', 'matches_regex'],
  enum: ['is', 'is_not', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
  duration: ['gt', 'lt', 'gte', 'lte'],
  number: ['is', 'is_not', 'gt', 'lt', 'gte', 'lte'],
  date: ['before', 'after', 'is_empty', 'is_not_empty'],
  list: ['has_any', 'has_all', 'has_none', 'is_empty', 'is_not_empty'],
});

/** One set of operator words for run explanations and step sentences. */
export const OPERATOR_WORDS = Object.freeze({
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain', in: 'is one of', not_in: 'is not one of',
  // QA 10-15 #2: "has no value" reads naturally for a person field
  // ("the Project Accountant has no value"); operator ids stay the same.
  is_empty: 'has no value', is_not_empty: 'has a value', is_true: 'is true', is_false: 'is not true',
  gt: 'is more than', lt: 'is less than', gte: 'is at least', lte: 'is at most', before: 'is before', after: 'is after',
  matches_regex: 'matches', has_any: 'has any of', has_all: 'has all of', has_none: 'has none of',
});

/** Auto-help reply verdicts the "Ignore a thank-you or out-of-office" switch stops. */
export const AUTO_HELP_THANKS_VERDICTS = Object.freeze(['confirmed', 'auto_reply']);
/**
 * "When a requester replies" (14 Oct 2026): how a reply to a closed ticket
 * reads (event.extra.replyVerdict) — 'thanks', 'auto_reply' or 'reply'. Set
 * only where that page's "A thank-you or out-of-office reply does not reopen"
 * switch is on; the same step switch stops on the first two.
 */
export const REPLY_STAYS_CLOSED_VERDICTS = Object.freeze(['thanks', 'auto_reply']);
const AUTO_HELP_VERDICT_PATH = 'event.extra.autoHelpReplyVerdict';
const MAX_ROWS = 20;
const CUSTOM_PATH = /^ticket\.customFields\.([a-z][a-z0-9_]{1,59})$/;
// Custom-field definition types whose rows compile with plain (string)
// semantics — only those convert, so the run behaves the same.
const CUSTOM_PLAIN_TYPES = { text: 'string', select: 'enum' };

/**
 * The switches a condition step checks before its conditions (the engine and
 * the conversion script both call this). Returns null, 'skip_noise' or
 * 'auto_help_thanks'.
 */
export function conditionSwitchStop(data, scope) {
  if (data?.skipNoise === true && scope?.ticket?.isNoise === true) return 'skip_noise';
  if (data?.ignoreAutoHelpThanks === true
    && (AUTO_HELP_THANKS_VERDICTS.includes(scope?.event?.extra?.autoHelpReplyVerdict)
      || REPLY_STAYS_CLOSED_VERDICTS.includes(scope?.event?.extra?.replyVerdict))) return 'auto_help_thanks';
  return null;
}

// ---------------------------------------------------------------- converter

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

function singleOp(node) {
  if (!isPlainObject(node)) return null;
  const keys = Object.keys(node);
  return keys.length === 1 ? keys[0] : null;
}

function varPath(node) {
  if (singleOp(node) !== 'var') return null;
  const v = node.var;
  if (typeof v === 'string' && v) return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && v[0]) return v[0];
  return null; // a default value changes what the rule reads
}

function argList(node, op) {
  const args = node[op];
  return Array.isArray(args) ? args : [args];
}

/** Field keys that read `path`, in catalog order. */
function fieldsForPath(path, customFieldTypes) {
  const custom = CUSTOM_PATH.exec(path);
  if (custom) {
    if (!customFieldTypes || typeof customFieldTypes !== 'object') return [];
    const defType = customFieldTypes[custom[1]];
    // Unknown key = the model's string fallback; typed number/date/boolean
    // definitions compile differently from a raw rule, so they never convert.
    const type = defType === undefined || defType === null ? 'string' : CUSTOM_PLAIN_TYPES[defType];
    return type ? [[`custom:${custom[1]}`, type]] : [];
  }
  return Object.entries(RULE_FIELDS).filter(([, spec]) => spec.path === path).map(([key, spec]) => [key, spec.type]);
}

function rowFor(path, operator, value, customFieldTypes) {
  const field = fieldsForPath(path, customFieldTypes).find(([, type]) => (RULE_OPERATORS[type] || []).includes(operator));
  if (!field) return null;
  return value === undefined ? { field: field[0], operator, value: null } : { field: field[0], operator, value };
}

const FLIP = { '>': '<', '<': '>', '>=': '<=', '<=': '>=' };
const COMPARE_OPS = { '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };

/** One json-logic test -> one builder row, or null. */
function leafToRow(node, ctx) {
  if (varPath(node)) return rowFor(varPath(node), 'is_not_empty', undefined, ctx);
  const op = singleOp(node);
  if (!op) return null;
  const args = argList(node, op);

  if (op === '==' || op === '!=') {
    if (args.length !== 2) return null;
    const [a, b] = args;
    const path = varPath(a) || varPath(b);
    const literal = varPath(a) ? b : a;
    if (!path || varPath(literal) || !isScalar(literal)) return null;
    if (literal === true) return rowFor(path, op === '==' ? 'is_true' : 'is_false', undefined, ctx);
    if (literal === false || literal === '') return null; // no builder row matches these exactly
    return rowFor(path, op === '==' ? 'is' : 'is_not', literal, ctx);
  }

  if (op === 'in') {
    if (args.length !== 2) return null;
    const [needle, haystack] = args;
    const needlePath = varPath(needle);
    if (needlePath && Array.isArray(haystack) && haystack.length > 0 && haystack.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) {
      return rowFor(needlePath, 'in', [...haystack], ctx);
    }
    const hayPath = varPath(haystack);
    if (hayPath && typeof needle === 'string' && needle !== '') return rowFor(hayPath, 'contains', needle, ctx);
    return null;
  }

  if (op === '!!') {
    if (args.length !== 1 || !varPath(args[0])) return null;
    return rowFor(varPath(args[0]), 'is_not_empty', undefined, ctx);
  }

  if (op === '!') {
    if (args.length !== 1) return null;
    const inner = args[0];
    if (varPath(inner)) return rowFor(varPath(inner), 'is_empty', undefined, ctx);
    const innerOp = singleOp(inner);
    if (innerOp === '==' || innerOp === '!=') {
      return leafToRow({ [innerOp === '==' ? '!=' : '==']: inner[innerOp] }, ctx);
    }
    if (innerOp === '!!') {
      const innerArgs = argList(inner, '!!');
      return innerArgs.length === 1 && varPath(innerArgs[0]) ? rowFor(varPath(innerArgs[0]), 'is_empty', undefined, ctx) : null;
    }
    if (innerOp === '!') {
      const innerArgs = argList(inner, '!');
      return innerArgs.length === 1 && varPath(innerArgs[0]) ? rowFor(varPath(innerArgs[0]), 'is_not_empty', undefined, ctx) : null;
    }
    if (innerOp === 'in') {
      // in / not_in and contains / not_contains are offered on the same field types.
      const row = leafToRow(inner, ctx);
      if (!row) return null;
      const negated = row.operator === 'in' ? 'not_in' : row.operator === 'contains' ? 'not_contains' : null;
      return negated ? { ...row, operator: negated } : null;
    }
    if (innerOp === 'list_has_any') {
      const row = leafToRow(inner, ctx);
      return row ? { ...row, operator: 'has_none' } : null;
    }
    return null;
  }

  if (COMPARE_OPS[op]) {
    if (args.length !== 2) return null; // three arguments = "between"
    const [a, b] = args;
    if (varPath(a) && typeof b === 'number' && Number.isFinite(b)) return rowFor(varPath(a), COMPARE_OPS[op], b, ctx);
    if (varPath(b) && typeof a === 'number' && Number.isFinite(a)) return rowFor(varPath(b), COMPARE_OPS[FLIP[op]], a, ctx);
    return null;
  }

  if (op === 'regex_match') {
    if (args.length !== 2 || !varPath(args[0]) || typeof args[1] !== 'string' || !args[1]) return null;
    try { RegExp(args[1]); } catch { return null; }
    return rowFor(varPath(args[0]), 'matches_regex', args[1], ctx);
  }

  if (op === 'list_has_any' || op === 'list_has_all') {
    if (args.length !== 2 || !varPath(args[0]) || !Array.isArray(args[1]) || args[1].length === 0) return null;
    if (!args[1].every((v) => typeof v === 'string' || typeof v === 'number')) return null;
    return rowFor(varPath(args[0]), op === 'list_has_any' ? 'has_any' : 'has_all', [...args[1]], ctx);
  }

  return null;
}

const LOGIC = { and: 'all', or: 'any' };

/** A json-logic and/or tree -> a group (root + one nested level), or null. */
function toGroup(node, depth, ctx) {
  const op = singleOp(node);
  if (!LOGIC[op]) {
    const row = leafToRow(node, ctx);
    return row ? { logic: 'all', conditions: [row] } : null;
  }
  const args = node[op];
  if (!Array.isArray(args) || args.length === 0) return null; // an empty and/or is falsy, an empty group passes
  const conditions = [];
  for (const arg of args) {
    const argOp = singleOp(arg);
    if (argOp === op) {
      const same = toGroup(arg, depth, ctx); // and inside and: same group
      if (!same) return null;
      conditions.push(...same.conditions);
    } else if (LOGIC[argOp]) {
      if (depth >= 2) return null; // the builder nests one level
      const nested = toGroup(arg, depth + 1, ctx);
      if (!nested) return null;
      if (nested.conditions.length === 1) conditions.push(nested.conditions[0]);
      else conditions.push(nested);
    } else {
      const row = leafToRow(arg, ctx);
      if (!row) return null;
      conditions.push(row);
    }
  }
  return { logic: LOGIC[op], conditions };
}

/** `!(verdict in [confirmed, auto_reply])` — the Auto-help reopen guard. */
function isAutoHelpThanksGuard(node) {
  if (singleOp(node) !== '!') return false;
  const args = argList(node, '!');
  if (args.length !== 1 || singleOp(args[0]) !== 'in') return false;
  const [needle, haystack] = argList(args[0], 'in');
  if (varPath(needle) !== AUTO_HELP_VERDICT_PATH || !Array.isArray(haystack)) return false;
  const set = new Set(haystack);
  return set.size === AUTO_HELP_THANKS_VERDICTS.length && AUTO_HELP_THANKS_VERDICTS.every((v) => set.has(v));
}

/** `isNoise != true` (or `!(isNoise == true)`) — the old "skip noise" rule. */
function isNoiseGuard(node) {
  const row = leafToRow(node, null);
  return Boolean(row && row.field === 'ticket.isNoise' && row.operator === 'is_false');
}

function countRows(group) {
  return group.conditions.reduce((n, c) => n + (Array.isArray(c?.conditions) ? countRows(c) : 1), 0);
}

/**
 * A raw json-logic condition rule as builder rows. Returns
 * { group, skipNoise, ignoreAutoHelpThanks } or null when the rule can not be
 * shown as rows without changing what it does.
 *
 * With `switches` (condition steps; not branches) a top-level "not noise"
 * test becomes the Skip noise switch and the Auto-help reopen guard becomes
 * the "Ignore a thank-you or out-of-office reply" switch.
 * `customFieldTypes` ({ key: definition type }) lets text/select custom-field
 * rules convert; without it custom fields stay code.
 */
export function ruleToConditionGroup(rule, { switches = true, customFieldTypes = null } = {}) {
  if (rule === true) return { group: { logic: 'all', conditions: [] }, skipNoise: false, ignoreAutoHelpThanks: false };
  if (!isPlainObject(rule)) return null;
  const ctx = customFieldTypes;
  let skipNoise = false;
  let ignoreAutoHelpThanks = false;
  let body = rule;
  if (switches) {
    // An empty "and" is falsy in json-logic, an empty group passes: not the same.
    if (singleOp(rule) === 'and' && (!Array.isArray(rule.and) || rule.and.length === 0)) return null;
    const conjuncts = singleOp(rule) === 'and' && Array.isArray(rule.and) ? rule.and : [rule];
    const rest = conjuncts.filter((c) => {
      if (isAutoHelpThanksGuard(c)) { ignoreAutoHelpThanks = true; return false; }
      if (isNoiseGuard(c)) { skipNoise = true; return false; }
      return true;
    });
    if (rest.length === 0) return { group: { logic: 'all', conditions: [] }, skipNoise, ignoreAutoHelpThanks };
    body = rest.length === 1 ? rest[0] : { and: rest };
  }
  const group = toGroup(body, 1, ctx);
  if (!group || countRows(group) > MAX_ROWS) return null;
  return { group, skipNoise, ignoreAutoHelpThanks };
}

/**
 * The patch that turns a condition step's raw rule into rows + switches, or
 * null when the step already has conditions or its rule can not convert.
 */
export function ruleConversionPatch(data = {}, options = {}) {
  if (data?.conditionGroup && Array.isArray(data.conditionGroup.conditions)) return null;
  if (data?.rule === undefined || data?.rule === null) return null;
  const converted = ruleToConditionGroup(data.rule, options);
  if (!converted) return null;
  return {
    conditionGroup: converted.group,
    rule: undefined,
    ...(converted.skipNoise ? { skipNoise: true } : {}),
    ...(converted.ignoreAutoHelpThanks ? { ignoreAutoHelpThanks: true } : {}),
  };
}

// ----------------------------------------------------------------- sentence

function joinWords(values, last = 'or') {
  const list = values.map((v) => String(v));
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} ${last} ${list[list.length - 1]}`;
}

function minutesWords(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const abs = Math.abs(n);
  const unit = (count, word) => `${count} ${word}${Math.abs(count) === 1 ? '' : 's'}`;
  if (abs !== 0 && abs % 1440 === 0) return unit(n / 1440, 'day');
  if (abs !== 0 && abs % 60 === 0) return unit(n / 60, 'hour');
  return unit(n, 'minute');
}

function fieldNoun(fieldKey, fields) {
  const known = RULE_FIELDS[fieldKey];
  if (known) return known.noun;
  const listed = Array.isArray(fields) ? fields.find((f) => f?.value === fieldKey) : null;
  const label = String(listed?.label || fieldKey).replace(/^Custom:\s*/i, '');
  return String(fieldKey).startsWith('custom:') ? `the custom field "${label}"` : `the field "${label}"`;
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);

/** One builder row as words, e.g. "the ticket status is Resolved or Closed". */
export function describeConditionRow(row, { fields = null } = {}) {
  const key = row?.field;
  const spec = RULE_FIELDS[key];
  const noun = fieldNoun(key, fields);
  const op = row?.operator;
  const value = row?.value;
  const listed = Array.isArray(fields) ? fields.find((f) => f?.value === key) : null;
  const type = spec?.type || listed?.type || 'string';
  switch (op) {
  case 'is_true': return spec?.yes || `${noun} is yes`;
  case 'is_false': return spec?.no || `${noun} is not yes`;
  case 'is': return `${noun} is ${value}`;
  case 'is_not': return `${noun} is not ${value}`;
  case 'in': return `${noun} is ${joinWords(asList(value), 'or') || 'one of (nothing picked)'}`;
  case 'not_in': return `${noun} is not ${joinWords(asList(value), 'or') || 'one of (nothing picked)'}`;
  case 'contains': return `${noun} contains "${value}"`;
  case 'not_contains': return `${noun} does not contain "${value}"`;
  case 'is_empty': return `${noun} has no value`;
  case 'is_not_empty': return `${noun} has a value`;
  case 'matches_regex': return `${noun} matches the pattern "${value}"`;
  case 'has_any': return `${noun} include ${joinWords(asList(value), 'or') || '(nothing picked)'}`;
  case 'has_all': return `${noun} include ${joinWords(asList(value), 'and') || '(nothing picked)'}`;
  case 'has_none': return `${noun} include none of ${joinWords(asList(value), 'or') || '(nothing picked)'}`;
  case 'gt': case 'lt': case 'gte': case 'lte': {
    const amount = type === 'duration' ? minutesWords(value) : String(value);
    return `${noun} ${OPERATOR_WORDS[op]} ${amount}`;
  }
  case 'before': case 'after': return `${noun} ${OPERATOR_WORDS[op]} ${String(value ?? '').slice(0, 10)}`;
  default: return `${noun} ${OPERATOR_WORDS[op] || op || ''} ${value ?? ''}`.trim();
  }
}

/** A group as words; nested groups read "either … or …" / "both … and …". */
export function describeConditionGroup(group, options = {}) {
  const parts = (group?.conditions || []).map((entry) => {
    if (Array.isArray(entry?.conditions)) {
      const inner = entry.conditions.map((c) => (Array.isArray(c?.conditions) ? describeConditionGroup(c, options) : describeConditionRow(c, options)));
      if (inner.length === 0) return 'anything';
      if (inner.length === 1) return inner[0];
      return entry.logic === 'any' ? `either ${joinWords(inner, 'or')}` : `both ${joinWords(inner, 'and')}`;
    }
    return describeConditionRow(entry, options);
  });
  return joinWords(parts, group?.logic === 'any' ? 'or' : 'and');
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * What a condition step checks, in one plain sentence. Works on a step with
 * conditions, a raw rule that converts, or neither (`null` = can not say).
 *   "Continues when the ticket status is Resolved, Closed or Pending Response."
 *   "Every ticket continues, except noise or spam."
 */
export function describeConditionStep(data = {}, { fields = null, short = false } = {}) {
  let group = data?.conditionGroup && Array.isArray(data.conditionGroup.conditions) ? data.conditionGroup : null;
  let skipNoise = data?.skipNoise === true;
  let thanks = data?.ignoreAutoHelpThanks === true;
  if (!group) {
    const rule = data?.rule === undefined || data?.rule === null ? true : data.rule;
    const converted = ruleToConditionGroup(rule);
    if (!converted) return null;
    group = converted.group;
    skipNoise = skipNoise || converted.skipNoise;
    thanks = thanks || converted.ignoreAutoHelpThanks;
  }
  const exceptions = [
    ...(skipNoise ? ['noise or spam'] : []),
    ...(thanks ? ['a thank-you or out-of-office reply after an Auto-help close'] : []),
  ];
  const checks = group.conditions.length ? describeConditionGroup(group, { fields }) : '';
  if (short) {
    if (checks) return capitalize(checks);
    return exceptions.length ? `All but ${joinWords(exceptions, 'and')}` : 'Every ticket';
  }
  const unless = exceptions.length ? `, except ${joinWords(exceptions, 'and')}` : '';
  if (!checks) return `Every ticket continues${unless}.`;
  return `Continues when ${checks}${unless}.`;
}

function varPathsIn(rule, out = new Set()) {
  if (Array.isArray(rule)) rule.forEach((r) => varPathsIn(r, out));
  else if (isPlainObject(rule)) {
    for (const [op, arg] of Object.entries(rule)) {
      if (op === 'var') {
        const path = Array.isArray(arg) ? arg[0] : arg;
        if (typeof path === 'string' && path) out.add(path);
      } else varPathsIn(arg, out);
    }
  }
  return out;
}

/**
 * For a rule that stays code: what it reads, in words — "It reads the ticket
 * status and the priority." (null when it reads nothing).
 */
export function describeRuleReads(rule) {
  const nouns = [...varPathsIn(rule)].map((path) => {
    const key = Object.keys(RULE_FIELDS).find((k) => RULE_FIELDS[k].path === path);
    if (key) return RULE_FIELDS[key].type === 'boolean' ? `whether ${RULE_FIELDS[key].yes}` : RULE_FIELDS[key].noun;
    const custom = CUSTOM_PATH.exec(path);
    return custom ? `the custom field "${custom[1]}"` : `"${path}"`;
  });
  const unique = [...new Set(nouns)];
  return unique.length ? `It reads ${joinWords(unique, 'and')}.` : null;
}

export default {
  RULE_FIELDS,
  RULE_OPERATORS,
  OPERATOR_WORDS,
  AUTO_HELP_THANKS_VERDICTS,
  REPLY_STAYS_CLOSED_VERDICTS,
  conditionSwitchStop,
  ruleToConditionGroup,
  ruleConversionPatch,
  describeConditionRow,
  describeConditionGroup,
  describeConditionStep,
  describeRuleReads,
};
