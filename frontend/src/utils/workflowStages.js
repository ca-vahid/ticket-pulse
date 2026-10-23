/**
 * Mail Workflows by ticket lifecycle stage (QA 10-19 #2 and #4).
 *
 * One map, used by the workflow list (its "Ticket lifecycle" navigation and
 * stage sections) and by the Audit tab's workflow picker, so the two group
 * workflows the same way. Each stage lists its trigger keys in the order a
 * ticket meets them; the keys are the engine's real trigger types
 * (backend notificationWorkflowDefinition.js / the panel's EVENT_LABELS).
 * Anything not listed here — including a trigger added later — falls into
 * "Other", so nothing ever drops off the list.
 */

/** Watch signals the list does not show (QA 10-19 #3); the editor still does. */
export const LIST_HIDDEN_SIGNALS = new Set(['noise_check_replaced']);

/** The workflow's watch signals that belong on the list rows and counts. */
export function listWatchSignals(workflow) {
  return (workflow?.watchSignals || []).filter((signal) => !LIST_HIDDEN_SIGNALS.has(signal?.code));
}

export const WORKFLOW_STAGES = [
  {
    key: 'intake',
    number: '01',
    label: 'Intake',
    blurb: 'New and triaged tickets',
    triggers: ['ticket.created', 'ticket.categorized', 'ticket.intake_settled', 'ticket.ready', 'auto_help.staged', 'auto_help.answered'],
  },
  {
    key: 'ownership',
    number: '02',
    label: 'Ownership',
    blurb: 'Who has the ticket',
    triggers: ['ticket.assigned', 'ticket.reassigned', 'ticket.unassigned_for'],
  },
  {
    key: 'changes',
    number: '03',
    label: 'Changes',
    blurb: 'While the ticket is open',
    triggers: [
      'ticket.priority_changed', 'ticket.status_changed', 'ticket.fields_updated', 'ticket.note_added',
      'ticket.parked', 'ticket.park_due_soon', 'ticket.woke',
      'ticket.aging', 'ticket.sla_pre_breach', 'ticket.sla_breach',
    ],
  },
  {
    key: 'requester',
    number: '04',
    label: 'Requester',
    blurb: 'Conversation with the requester',
    triggers: ['ticket.reply_received', 'ticket.public_reply_added', 'ticket.requester_silent_for', 'auto_help.nudged', 'auto_help.help_requested'],
  },
  {
    key: 'closure',
    number: '05',
    label: 'Closure',
    blurb: 'Resolved, closed and reopened',
    triggers: ['ticket.resolved_closed', 'auto_help.resolved', 'ticket.reopened'],
  },
  {
    key: 'other',
    number: '06',
    label: 'Other',
    blurb: 'Approvals, schedules and sub-workflows',
    triggers: ['approval.requested', 'approval.clarification_requested', 'approval.decided', 'schedule.time', 'manual'],
  },
];

const STAGE_BY_KEY = new Map(WORKFLOW_STAGES.map((stage) => [stage.key, stage]));
const OTHER = STAGE_BY_KEY.get('other');
const TRIGGER_STAGE = new Map();
const TRIGGER_RANK = new Map();
for (const stage of WORKFLOW_STAGES) {
  stage.triggers.forEach((trigger, index) => {
    TRIGGER_STAGE.set(trigger, stage);
    TRIGGER_RANK.set(trigger, index);
  });
}

/** The stage a trigger belongs to; unknown triggers land in Other. */
export function stageForTrigger(triggerType) {
  return TRIGGER_STAGE.get(triggerType) || OTHER;
}

/** Defaults lead; variants follow (live before archived, then routing order, then name). */
function orderVariants(list) {
  return [...list].sort((a, b) => (
    Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt))
    || (a.routingPriority || 1) - (b.routingPriority || 1)
    || String(a.name || '').localeCompare(String(b.name || ''))
  ));
}

/** A non-default workflow that runs alongside the default instead of replacing it. */
export function runsInAddition(workflow) {
  return Boolean(workflow) && !workflow.isDefaultVariant && workflow.triggerType !== 'manual'
    && String(workflow.routingMode || '').toLowerCase() === 'additive';
}

/** Business-hours family first, then the rest (after-hours) by key. */
function familyRank(key) {
  return key === 'standard' ? 0 : 1;
}

/**
 * Group workflows into stages → triggers → families → parent + variants.
 *
 * Returns only the stages and triggers that have workflows, in lifecycle
 * order:
 *   [{ stage, triggers: [{ triggerType, label, parent, variants, families, workflows, nested, lastNested, count }], count }]
 *
 * QA 10-20 #5: a trigger can hold more than one default. "Ticket arrived"
 * has the business-hours default and the after-hours default, and each has
 * its own variants. `familyOf(workflow)` names the family ('standard' or
 * 'after_hours'); each family's default heads its own block, so "Ticket
 * arrived during business hours" no longer hangs under the after-hours one.
 * Without `familyOf` every workflow of a trigger is one family, as before.
 *
 * QA 10-22 #8: `alongside` holds a family's "Runs in addition" workflows;
 * they follow the variants at the top level, never indented.
 *
 * `families`: [{ key, parent, variants, alongside }] — a family with no default lists
 * its workflows at the top level, none indented. `workflows` is the flat
 * order to render; `nested` (Set of ids) marks the indented variants and
 * `lastNested` the last one of each family (the elbow ends there). `parent`
 * and `variants` describe the first family (kept for older callers).
 */
export function groupWorkflowsByStage(workflows = [], eventLabels = {}, { familyOf = null } = {}) {
  const byTrigger = new Map();
  for (const workflow of workflows || []) {
    const key = workflow?.triggerType || 'other';
    if (!byTrigger.has(key)) byTrigger.set(key, []);
    byTrigger.get(key).push(workflow);
  }
  const labelOf = (key) => eventLabels[key] || key;
  const stages = new Map();
  for (const [triggerType, list] of byTrigger) {
    const stage = stageForTrigger(triggerType);
    const byFamily = new Map();
    for (const workflow of list) {
      const key = (familyOf && familyOf(workflow)) || 'standard';
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(workflow);
    }
    const families = [...byFamily.entries()]
      .sort(([a], [b]) => familyRank(a) - familyRank(b) || String(a).localeCompare(String(b)))
      .map(([key, members]) => {
        const parent = members.find((w) => w.isDefaultVariant && !w.archivedAt) || members.find((w) => w.isDefaultVariant) || null;
        const rest = orderVariants(members.filter((w) => w !== parent));
        // QA 10-22 #8: only a variant that can replace the default hangs off it.
        // A "Runs in addition" workflow is its own automation and stands alone.
        const variants = parent ? rest.filter((w) => !runsInAddition(w)) : rest;
        const alongside = parent ? rest.filter(runsInAddition) : [];
        return { key, parent, variants, alongside };
      });
    const nested = new Set();
    const lastNested = new Set();
    const flat = [];
    for (const family of families) {
      if (family.parent) {
        flat.push(family.parent);
        for (const variant of family.variants) nested.add(variant.id);
        if (family.variants.length) lastNested.add(family.variants[family.variants.length - 1].id);
      }
      flat.push(...family.variants, ...family.alongside);
    }
    if (!stages.has(stage.key)) stages.set(stage.key, []);
    stages.get(stage.key).push({
      triggerType,
      label: labelOf(triggerType),
      parent: families[0]?.parent || null,
      variants: families[0]?.variants || [],
      families,
      workflows: flat,
      nested,
      lastNested,
      count: list.length,
    });
  }
  return WORKFLOW_STAGES
    .filter((stage) => stages.has(stage.key))
    .map((stage) => {
      const triggers = stages.get(stage.key).sort((a, b) => {
        const ra = TRIGGER_RANK.get(a.triggerType) ?? Infinity;
        const rb = TRIGGER_RANK.get(b.triggerType) ?? Infinity;
        if (ra !== rb) return ra - rb;
        return String(a.label).localeCompare(String(b.label));
      });
      return { stage, triggers, count: triggers.reduce((sum, t) => sum + t.count, 0) };
    });
}
