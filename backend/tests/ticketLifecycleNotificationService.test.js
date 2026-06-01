import { deriveTicketLifecycleEvents } from '../src/services/ticketLifecycleNotificationService.js';

describe('ticket lifecycle notification event derivation', () => {
  test('new assigned ticket emits arrived and assigned events', () => {
    const events = deriveTicketLifecycleEvents(null, {
      id: 1,
      createdAt: new Date('2026-05-29T18:00:00.000Z'),
      assignedAt: new Date('2026-05-29T18:03:00.000Z'),
      assignedTechId: 17,
      status: 'Open',
    });

    expect(events.map((event) => event.type)).toEqual(['ticket.created', 'ticket.assigned']);
    expect(events[0].occurredAt).toBe('2026-05-29T18:00:00.000Z');
    expect(events[1].occurredAt).toBe('2026-05-29T18:03:00.000Z');
  });

  test('assignment changes distinguish first assignment from reassignment', () => {
    expect(deriveTicketLifecycleEvents(
      { assignedTechId: null, status: 'Open' },
      { assignedTechId: 21, assignedAt: new Date('2026-05-29T19:00:00.000Z'), status: 'Open' },
    ).map((event) => event.type)).toEqual(['ticket.assigned']);

    expect(deriveTicketLifecycleEvents(
      { assignedTechId: 20, status: 'Open' },
      { assignedTechId: 21, assignedAt: new Date('2026-05-29T19:02:00.000Z'), status: 'Open' },
    ).map((event) => event.type)).toEqual(['ticket.reassigned']);
  });

  test('assignment after prior unassignment is treated as reassignment', () => {
    const events = deriveTicketLifecycleEvents(
      {
        assignedTechId: null,
        firstAssignedAt: new Date('2026-05-29T18:00:00.000Z'),
        status: 'Open',
      },
      {
        assignedTechId: 21,
        firstAssignedAt: new Date('2026-05-29T18:00:00.000Z'),
        assignedAt: new Date('2026-05-29T19:00:00.000Z'),
        status: 'Open',
      },
    );

    expect(events.map((event) => event.type)).toEqual(['ticket.reassigned']);
    expect(events[0].dedupeStamp).toBe('2026-05-29T19:00:00.000Z');
  });

  test('assigned event uses stable first-assignment stamp when available', () => {
    const events = deriveTicketLifecycleEvents(
      { assignedTechId: null, status: 'Open' },
      {
        assignedTechId: 21,
        firstAssignedAt: new Date('2026-05-29T18:59:00.000Z'),
        assignedAt: new Date('2026-05-29T19:00:00.000Z'),
        status: 'Open',
      },
    );

    expect(events.map((event) => event.type)).toEqual(['ticket.assigned']);
    expect(events[0].dedupeStamp).toBe('2026-05-29T18:59:00.000Z');
  });

  test('resolved and closed statuses share one terminal event', () => {
    expect(deriveTicketLifecycleEvents(
      { assignedTechId: 20, status: 'Open' },
      { assignedTechId: 20, status: 'Resolved', resolvedAt: new Date('2026-05-29T20:00:00.000Z') },
    ).map((event) => event.type)).toEqual(['ticket.resolved_closed']);

    expect(deriveTicketLifecycleEvents(
      { assignedTechId: 20, status: 'Resolved' },
      { assignedTechId: 20, status: 'Closed', closedAt: new Date('2026-05-29T21:00:00.000Z') },
    )).toEqual([]);
  });
});
