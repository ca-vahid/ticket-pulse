/**
 * Which condition fields have a value on which trigger (MEGA 11-14, A4 item 6).
 *
 * The condition picker used to list every "event" field on every trigger, so
 * a "Requester replied" step offered "Changed fields" and "Intake decision",
 * which are always empty there. Each `event.*` field below names the triggers
 * whose event carries it (worked out from where each `event.extra.*` key is
 * set in the backend emitters, 15 Nov 2026).
 *
 * Everything else — `ticket.*`, `requester.*`, `assignedAgent.*`,
 * `availability.*`, `workspace.*` and custom fields — is read from the ticket
 * or the clock and fits every trigger. An `event.*` field this map does not
 * know is also shown everywhere, so a new field can never vanish from the
 * picker before it is added here.
 *
 * Frontend only: the engine still evaluates any field on any trigger (an
 * empty field reads as "has no value" / "is not true").
 */

const REPLY = 'ticket.reply_received';
// Events derived from a ticket's lifecycle carry the editor's kind (actorKind).
const LIFECYCLE = ['ticket.created', 'ticket.assigned', 'ticket.reassigned', 'ticket.resolved_closed', 'ticket.status_changed', 'ticket.reopened'];

export const EVENT_FIELD_TRIGGERS = Object.freeze({
  // from/to on a status move (ticket.priority_changed reuses the keys for priority numbers).
  'event.statusFrom': ['ticket.status_changed', 'ticket.reopened'],
  'event.statusTo': ['ticket.status_changed', 'ticket.reopened'],
  'event.systemNote': ['ticket.note_added'],
  // "Ticket updated (fields)".
  'event.changedFields': ['ticket.fields_updated'],
  'event.changedCount': ['ticket.fields_updated'],
  'event.actorKind': ['ticket.fields_updated', 'ticket.priority_changed', ...LIFECYCLE],
  'event.source': ['ticket.fields_updated', 'ticket.priority_changed'],
  'event.reopened': ['ticket.fields_updated', 'ticket.reopened'],
  // "Ticket intake settled".
  'event.intakeProvisional': ['ticket.intake_settled'],
  'event.intakeDecision': ['ticket.intake_settled'],
  'event.intakeNonActionable': ['ticket.intake_settled'],
  'event.intakeSource': ['ticket.intake_settled'],
  // "Ticket ready".
  'event.readyReason': ['ticket.ready'],
  'event.autoHelpAnswered': ['ticket.ready'],
  // "Requester replied".
  'event.senderIsAgent': [REPLY],
  'event.isSurveyResponse': [REPLY],
  'event.autoHelpReplyVerdict': [REPLY],
  'event.replyVerdict': [REPLY],
  'event.replyToWorkflowEmail': [REPLY],
  'event.replyToWorkflow': [REPLY],
  'event.sentBy': [REPLY],
  'event.replyReopens24h': [REPLY],
});

/**
 * Triggers whose context can hold any field: a manual run or sub-workflow
 * gets the caller's event, and no trigger at all means "do not filter".
 */
const SHOWS_EVERYTHING = new Set(['manual']);

/** Whether `fieldKey` has a value on `triggerType` (true when either is unknown). */
export function fieldFitsTrigger(fieldKey, triggerType) {
  if (!triggerType || SHOWS_EVERYTHING.has(triggerType)) return true;
  const key = String(fieldKey || '');
  if (!key.startsWith('event.')) return true;
  const triggers = EVENT_FIELD_TRIGGERS[key];
  return !triggers || triggers.includes(triggerType);
}

/** Every field key a condition group uses (nested groups included). */
export function fieldsUsedIn(group, out = new Set()) {
  for (const entry of group?.conditions || []) {
    if (Array.isArray(entry?.conditions)) fieldsUsedIn(entry, out);
    else if (entry?.field) out.add(entry.field);
  }
  return out;
}

/**
 * The picker's list for a trigger: the fields that fit it, plus any field the
 * rule already uses, marked `notSetByTrigger` so the row can say so.
 */
export function fieldsForTrigger(fields, triggerType, group = null) {
  const used = fieldsUsedIn(group);
  return (fields || []).flatMap((field) => {
    if (fieldFitsTrigger(field.value, triggerType)) return [field];
    return used.has(field.value) ? [{ ...field, notSetByTrigger: true }] : [];
  });
}

export default { EVENT_FIELD_TRIGGERS, fieldFitsTrigger, fieldsUsedIn, fieldsForTrigger };
