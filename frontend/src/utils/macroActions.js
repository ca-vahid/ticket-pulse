/**
 * Macros as an ordered action list (QA 11-05 #2). Mirrors
 * backend/src/services/ticketMacroService.js: the same step types, the same
 * read of the pre-11-05 key shape, and the variables the reply-greeting filler
 * understands (backend replyGreetingService.fillGreetingPlaceholders).
 */

export const MACRO_ACTIONS = [
  { type: 'reply', label: 'Reply to the requester', hint: 'Goes out through the normal reply path: signature, threading and the FreshService copy work as usual.' },
  { type: 'note', label: 'Add an internal note', hint: 'Only agents see it.' },
  { type: 'status', label: 'Set status', hint: 'Always runs last, after everything else.' },
  { type: 'priority', label: 'Set priority' },
  { type: 'category', label: 'Set category' },
  { type: 'group', label: 'Set group', tpOnly: true },
  { type: 'assign', label: 'Assign to' },
  { type: 'type', label: 'Set type', tpOnly: true },
  { type: 'tags', label: 'Add tags', hint: 'Added to the tags already on the ticket; none are removed.' },
  { type: 'due', label: 'Set the due date' },
  { type: 'custom_field', label: 'Set a custom field', tpOnly: true },
];
export const MACRO_ACTION_BY_TYPE = Object.fromEntries(MACRO_ACTIONS.map((a) => [a.type, a]));

/** Variables offered by "Insert variable" (all filled when the macro runs). */
export const MACRO_VARIABLES = [
  { token: '{{requester.firstName}}', label: 'Requester first name' },
  { token: '{{requester.name}}', label: 'Requester full name' },
  { token: '{{requester.email}}', label: 'Requester e-mail' },
  { token: '{{ticket.ref}}', label: 'Ticket number (TP-n)' },
  { token: '{{ticket.subject}}', label: 'Ticket subject' },
  { token: '{{assignee.firstName}}', label: 'Assignee first name' },
  { token: '{{assignee.name}}', label: 'Assignee full name' },
  { token: '{{agent.firstName}}', label: 'Your first name (who applies it)' },
  { token: '{{agent.name}}', label: 'Your full name' },
  { token: '{{workspace.name}}', label: 'Team / workspace name' },
];

export const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => v !== undefined && v !== null && v !== '';
let seq = 0;
export const newStepId = () => `s${Date.now().toString(36)}${(seq += 1).toString(36)}`;

// The early editor default ignored the workspace's ticket-number position
// (4.3.45): read it as "no subject typed" = the workspace's reply subject.
const OLD_DEFAULT_SUBJECT_RE = /^\s*\[\s*\{\{\s*ticket\.ref\s*\}\}\s*\]\s*\{\{\s*ticket\.subject\s*\}\}\s*$/;
const tidyStep = (s) => {
  if (s.type !== 'reply' || typeof s.subject !== 'string' || !OLD_DEFAULT_SUBJECT_RE.test(s.subject)) return s;
  const rest = { ...s };
  delete rest.subject;
  return rest;
};

/** The ordered steps behind any stored shape (array, v2 object, or the old keys). */
export function macroSteps(actions) {
  if (Array.isArray(actions)) return actions.filter(isObj).map(tidyStep);
  if (!isObj(actions)) return [];
  if (Array.isArray(actions.steps)) return actions.steps.filter(isObj).map(tidyStep);
  const steps = [];
  if (nonEmpty(actions.assignToTechnicianId)) steps.push({ type: 'assign', to: 'technician', technicianId: Number(actions.assignToTechnicianId) });
  if (nonEmpty(actions.setPriority)) steps.push({ type: 'priority', priority: Number(actions.setPriority) });
  if (nonEmpty(actions.addNote)) steps.push({ type: 'note', text: String(actions.addNote) });
  if (nonEmpty(actions.replyBody)) steps.push({ type: 'reply', text: String(actions.replyBody) });
  if (nonEmpty(actions.setStatus)) steps.push({ type: 'status', status: String(actions.setStatus) });
  return steps;
}

/** A blank step of a type, ready for the editor. */
export function blankStep(type) {
  const id = newStepId();
  switch (type) {
  case 'reply': return { id, type, subject: '', html: '' };
  case 'note': return { id, type, html: '' };
  case 'status': return { id, type, status: '' };
  case 'priority': return { id, type, priority: 2 };
  case 'category': return { id, type, categoryId: '', subcategoryId: '' };
  case 'group': return { id, type, groupId: '' };
  case 'assign': return { id, type, to: 'applier', technicianId: '' };
  case 'type': return { id, type, ticketType: '' };
  case 'tags': return { id, type, tagIds: [] };
  case 'due': return { id, type, amount: 1, unit: 'days' };
  case 'custom_field': return { id, type, key: '', label: '', value: '' };
  default: return { id, type };
  }
}

const textToHtml = (text) => String(text || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .split(/\r?\n/).map((line) => `<p>${line || '<br>'}</p>`).join('');

/** Steps as the editor holds them: every step has an id; old text bodies become HTML. */
export function editableSteps(actions) {
  return macroSteps(actions).map((s) => {
    const step = { ...s, id: s.id || newStepId() };
    if ((s.type === 'note' || s.type === 'reply') && !s.html && s.text) {
      step.html = textToHtml(s.text);
      delete step.text;
    }
    return step;
  });
}

/** Steps as the API takes them (blank optional fields dropped). */
export function stepsForSave(steps) {
  return steps.map((s) => {
    const out = { ...s };
    if (s.type === 'category' && !nonEmpty(s.subcategoryId)) delete out.subcategoryId;
    if (s.type === 'assign' && s.to === 'applier') delete out.technicianId;
    if (s.type === 'reply' && !String(s.subject || '').trim()) delete out.subject;
    return out;
  });
}

/** One plain line per step for the list ("Set status to Closed"). */
export function describeStep(step, lookups = {}) {
  const { categories = [], groups = [], technicians = [], tags = [] } = lookups;
  const catName = (id) => {
    for (const top of categories) {
      if (Number(top.id) === Number(id)) return top.name;
      const sub = (top.subcategories || []).find((s) => Number(s.id) === Number(id));
      if (sub) return sub.name;
    }
    return null;
  };
  switch (step.type) {
  case 'reply': return 'Reply to the requester';
  case 'note': return 'Add an internal note';
  case 'status': return step.status ? `Set status to ${step.status}` : 'Set status';
  case 'priority': return `Set priority to ${PRIORITY_LABELS[Number(step.priority)] || step.priority}`;
  case 'category': {
    const label = [catName(step.categoryId), catName(step.subcategoryId)].filter(Boolean).join(' / ');
    return label ? `Set category to ${label}` : 'Set category';
  }
  case 'group': {
    const g = groups.find((x) => Number(x.id) === Number(step.groupId));
    return g ? `Set group to ${g.name}` : 'Set group';
  }
  case 'assign': {
    if (step.to === 'applier') return 'Assign to the person applying it';
    const t = technicians.find((x) => Number(x.id) === Number(step.technicianId));
    return t ? `Assign to ${t.name}` : 'Assign to';
  }
  case 'type': return step.ticketType ? `Set type to ${step.ticketType}` : 'Set type';
  case 'tags': {
    const names = (step.tagIds || []).map((id) => tags.find((t) => Number(t.id) === Number(id))?.name).filter(Boolean);
    return names.length ? `Add tag${names.length === 1 ? '' : 's'} ${names.join(', ')}` : 'Add tags';
  }
  case 'due': return `Due ${step.amount} ${step.unit === 'hours' ? 'hour' : 'day'}${Number(step.amount) === 1 ? '' : 's'} after it is applied`;
  case 'custom_field': return step.key ? `Set ${step.label || step.key}` : 'Set a custom field';
  default: return step.type;
  }
}
