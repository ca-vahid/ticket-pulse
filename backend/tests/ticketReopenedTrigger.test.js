import { describe, expect, test } from '@jest/globals';
import { deriveTicketLifecycleEvents } from '../src/services/ticketLifecycleNotificationService.js';
import {
  NOTIFICATION_EVENT_TYPES,
  DEFAULT_WORKFLOW_SPECS,
  buildDefaultWorkflowDefinition,
  defaultWorkflowMetadataForSpec,
} from '../src/services/notificationWorkflowDefinition.js';

/**
 * FR 09-11 #4 — "Add an email notification workflow where it only notifies the
 * assigned agent when the ticket is reopened. Add a trigger called
 * 'ticket reopened'."
 *
 * Manager's doubt, quoted: "the ticket doesn't automatically reopen, only
 * agents can reopen tickets, no?" — half right. Ticket Pulse CAN reopen
 * automatically (the seeded 'Reopen on requester reply' action workflow), but
 * production showed that workflow switched off in every workspace, so in
 * practice nothing reopened by itself. Hence a named trigger that fires
 * whatever did the reopening.
 */

const ticket = (status, over = {}) => ({
  id: 1, workspaceId: 5, status, origin: 'ticketpulse', nativeNumber: 1291,
  freshserviceTicketId: null, assignedTechId: 7, updatedAt: new Date('2026-09-12T10:00:00Z'),
  ...over,
});

const types = (from, to) => deriveTicketLifecycleEvents(ticket(from), ticket(to)).map((e) => e.type);

describe('the trigger exists and is addressable', () => {
  test('registered as an event type', () => {
    expect(NOTIFICATION_EVENT_TYPES).toContain('ticket.reopened');
  });

  test('seeded as a workflow so admins can find it without building one', () => {
    const spec = DEFAULT_WORKFLOW_SPECS.find((s) => s.triggerType === 'ticket.reopened');
    expect(spec).toBeTruthy();
    expect(defaultWorkflowMetadataForSpec(spec).name).toBe('Ticket reopened');
  });

  test('notifies the ASSIGNED AGENT, not the requester — the actual ask', () => {
    const def = buildDefaultWorkflowDefinition('ticket.reopened');
    const resolver = def.nodes.find((n) => n.type === 'recipient_resolver');
    expect(resolver.data.to).toEqual(['assigned_agent']);
    expect(resolver.data.to).not.toContain('requester');
  });
});

describe('it fires on a reopen, and only on a reopen', () => {
  test.each([
    ['Closed', 'Open'],
    ['Resolved', 'Open'],
    ['Closed', 'Pending'],
  ])('%s -> %s is a reopen', (from, to) => {
    expect(types(from, to)).toContain('ticket.reopened');
  });

  test.each([
    ['Open', 'Pending'],
    ['Pending', 'Open'],
    ['Open', 'Resolved'],
    ['Resolved', 'Closed'],
  ])('%s -> %s is NOT a reopen', (from, to) => {
    expect(types(from, to)).not.toContain('ticket.reopened');
  });

  test('a ticket that did not change status fires nothing', () => {
    expect(types('Closed', 'Closed')).not.toContain('ticket.reopened');
  });

  test('closing a ticket still fires resolved_closed, not reopened', () => {
    const t = types('Open', 'Closed');
    expect(t).toContain('ticket.resolved_closed');
    expect(t).not.toContain('ticket.reopened');
  });
});

describe('the payload explains what happened', () => {
  const events = deriveTicketLifecycleEvents(ticket('Closed'), ticket('Open'));
  const reopened = events.find((e) => e.type === 'ticket.reopened');

  test('carries the status pair so "only from Closed" stays expressible', () => {
    expect(reopened.extra).toMatchObject({ from: 'Closed', to: 'Open', reopened: true });
  });

  test('status_changed still fires alongside — they are distinct triggers', () => {
    expect(events.map((e) => e.type)).toContain('ticket.status_changed');
  });

  test('has its own dedupe stamp, so it cannot collapse into status_changed', () => {
    const changed = events.find((e) => e.type === 'ticket.status_changed');
    expect(reopened.dedupeStamp).toBeTruthy();
    expect(reopened.dedupeStamp).not.toBe(changed.dedupeStamp);
  });
});

describe('custom statuses are respected', () => {
  test('a workspace-defined terminal status counts as a reopen source', () => {
    // ws5 uses custom names; the caller passes its own terminal predicate.
    const isTerminal = (s) => ['Signed off', 'Closed'].includes(s);
    const out = deriveTicketLifecycleEvents(
      ticket('Signed off'), ticket('In progress'), { isTerminal },
    ).map((e) => e.type);
    expect(out).toContain('ticket.reopened');
  });

  test('and a custom non-terminal pair still is not a reopen', () => {
    const isTerminal = (s) => ['Signed off', 'Closed'].includes(s);
    const out = deriveTicketLifecycleEvents(
      ticket('In progress'), ticket('With client'), { isTerminal },
    ).map((e) => e.type);
    expect(out).not.toContain('ticket.reopened');
  });
});
