/**
 * What kind of mailbox a connection is (plans/IT_INTAKE_MIGRATION_PLAN.md, 12 Oct 2026).
 * 'standard' = a side mailbox: replies, and the odd new ticket.
 * 'helpdesk' = the team's front door: nothing is dropped silently, a no-reply sender is a ticket,
 *              and mail with no reference is a new ticket (never glued to the sender's open one).
 */
export const INTAKE_PROFILES = Object.freeze(['standard', 'helpdesk']);

export function isHelpdeskMailbox(connection) {
  return String(connection?.intakeProfile || '').toLowerCase() === 'helpdesk';
}
