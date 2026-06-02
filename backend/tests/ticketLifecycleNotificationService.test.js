import {
  deriveTicketLifecycleEvents,
  lifecycleNotificationFingerprint,
} from '../src/services/ticketLifecycleNotificationService.js';

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

  test('assignment fingerprint is stable across assignment pipeline and webhook timestamp drift', () => {
    const existing = {
      id: 501,
      workspaceId: 1,
      assignedTechId: null,
      status: 'Open',
    };
    const fromPipeline = {
      id: 501,
      workspaceId: 1,
      assignedTechId: 17,
      firstAssignedAt: new Date('2026-06-01T16:00:00.000Z'),
      assignedAt: new Date('2026-06-01T16:00:01.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:00:02.000Z'),
      status: 'Open',
    };
    const fromWebhook = {
      ...fromPipeline,
      assignedAt: new Date('2026-06-01T16:00:02.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:00:03.000Z'),
    };

    const pipelineEvent = deriveTicketLifecycleEvents(existing, fromPipeline)[0];
    const webhookEvent = deriveTicketLifecycleEvents(existing, fromWebhook)[0];

    expect(pipelineEvent.type).toBe('ticket.assigned');
    expect(webhookEvent.type).toBe('ticket.assigned');
    expect(pipelineEvent.notificationFingerprint).toBe(webhookEvent.notificationFingerprint);
    expect(pipelineEvent.notificationFingerprint).toBe('1:ticket.assigned:501:17:2026-06-01T16:00:00.000Z');
  });

  test('assignment fingerprint stays stable for repeated assignment_pipeline runs with different dedupe stamps', () => {
    const first = lifecycleNotificationFingerprint('ticket.assigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 17,
      firstAssignedAt: new Date('2026-06-01T16:00:00.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:00:01.000Z'),
    }, { assignedTechId: null });
    const second = lifecycleNotificationFingerprint('ticket.assigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 17,
      firstAssignedAt: new Date('2026-06-01T16:00:00.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:00:20.000Z'),
    }, { assignedTechId: null });

    expect(first).toBe(second);
  });

  test('assignment fingerprint covers fast sync after pipeline completion without source timestamps', () => {
    const pipeline = lifecycleNotificationFingerprint('ticket.assigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 17,
      firstAssignedAt: new Date('2026-06-01T16:00:00.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:00:01.000Z'),
    }, { assignedTechId: null });
    const fastSync = lifecycleNotificationFingerprint('ticket.assigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 17,
      firstAssignedAt: new Date('2026-06-01T16:00:00.000Z'),
      freshserviceUpdatedAt: new Date('2026-06-01T16:01:00.000Z'),
    }, null);

    expect(fastSync).toBe(pipeline);
  });

  test('reassignment fingerprint includes old and new assignees', () => {
    const first = lifecycleNotificationFingerprint('ticket.reassigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 21,
      assignedAt: new Date('2026-06-01T18:00:00.000Z'),
    }, { workspaceId: 1, assignedTechId: 17 });
    const second = lifecycleNotificationFingerprint('ticket.reassigned', {
      id: 501,
      workspaceId: 1,
      assignedTechId: 22,
      assignedAt: new Date('2026-06-01T18:00:00.000Z'),
    }, { workspaceId: 1, assignedTechId: 17 });

    expect(first).toBe('1:ticket.reassigned:501:17:21:2026-06-01T18:00:00.000Z');
    expect(second).not.toBe(first);
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
