import { jest } from '@jest/globals';

/**
 * Regression tests for the ticket-event → workflow-engine wiring: every
 * registered event must actually reach notificationWorkflowEngine.executeForEvent
 * with a well-formed event context. (The original bug: events defined in
 * NOTIFICATION_EVENT_TYPES that no code path ever fired.)
 */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  technician: { findUnique: jest.fn() },
};
const engineMock = {
  executeForEvent: jest.fn().mockResolvedValue({ status: 'completed' }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: engineMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  emitTicketEvent,
  emitTicketLifecycleNotifications,
} = await import('../src/services/ticketLifecycleNotificationService.js');
const { NOTIFICATION_EVENT_TYPES } = await import('../src/services/notificationWorkflowDefinition.js');

const hydratedTicket = {
  id: 501,
  workspaceId: 1,
  freshserviceTicketId: BigInt(90001),
  subject: 'Projector flickers',
  descriptionText: 'flickers',
  status: 'Open',
  priority: 3,
  toEmails: [],
  ccEmails: [],
  replyCcEmails: [],
  fwdEmails: [],
  createdAt: new Date('2026-07-06T09:00:00.000Z'),
  workspace: { name: 'IT', defaultTimezone: 'America/Vancouver' },
  requester: { id: 40, name: 'Rita', email: 'rita@example.com' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...hydratedTicket });
  engineMock.executeForEvent.mockResolvedValue({ status: 'completed' });
});

describe('emitTicketEvent → engine dispatch', () => {
  const singleEventCases = [
    ['ticket.reply_received', { dedupeStamp: 'fs-conv-77' }],
    ['ticket.note_added', { dedupeStamp: 'note:9001', extra: { entryId: 9001, byEmail: 'cora@example.com' } }],
    ['ticket.public_reply_added', { dedupeStamp: 'reply:9002', extra: { entryId: 9002, byEmail: 'cora@example.com' } }],
    ['approval.requested', { dedupeStamp: 'approval.requested:12:requested', extra: { approvalId: 12 } }],
    ['approval.decided', { dedupeStamp: 'approval.decided:12:approved', extra: { approvalId: 12, status: 'approved' } }],
    ['approval.clarification_requested', { dedupeStamp: 'approval.clarification_requested:12:info', extra: { approvalId: 12 } }],
  ];

  test.each(singleEventCases)('%s reaches the engine with type, stamp and extra intact', async (eventType, options) => {
    const result = await emitTicketEvent(eventType, 501, options);

    expect(result).toEqual({ status: 'completed' });
    expect(engineMock.executeForEvent).toHaveBeenCalledTimes(1);
    const [eventContext] = engineMock.executeForEvent.mock.calls[0];
    expect(eventContext.event.type).toBe(eventType);
    expect(eventContext.event.dedupeStamp).toBe(options.dedupeStamp);
    if (options.extra) expect(eventContext.event.extra).toEqual(options.extra);
    expect(eventContext.ticket.id).toBe(501);
    expect(eventContext.workspace.id).toBe(1);
    expect(eventContext.requester.email).toBe('rita@example.com');
  });

  test('every event fired via emitTicketEvent is a registered trigger type', () => {
    for (const [eventType] of singleEventCases) {
      expect(NOTIFICATION_EVENT_TYPES).toContain(eventType);
    }
  });

  test('missing ticket is a skip, not a crash', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);
    const result = await emitTicketEvent('ticket.note_added', 999, { dedupeStamp: 'note:1' });
    expect(result.status).toBe('skipped');
    expect(engineMock.executeForEvent).not.toHaveBeenCalled();
  });

  test('engine failure is contained (returns failed, does not throw)', async () => {
    engineMock.executeForEvent.mockRejectedValue(new Error('engine down'));
    const result = await emitTicketEvent('ticket.note_added', 501, { dedupeStamp: 'note:1' });
    expect(result.status).toBe('failed');
  });
});

describe('emitTicketLifecycleNotifications → engine dispatch (derived events)', () => {
  test('status transition dispatches ticket.status_changed with from/to extra', async () => {
    const result = await emitTicketLifecycleNotifications({
      existingTicket: { id: 501, workspaceId: 1, assignedTechId: null, status: 'Open' },
      upsertedTicket: {
        id: 501,
        workspaceId: 1,
        assignedTechId: null,
        status: 'Pending',
        freshserviceUpdatedAt: new Date('2026-07-06T10:00:00.000Z'),
      },
      source: 'freshservice_sync',
      allowNotificationWorkflows: true,
    });

    expect(result.status).toBe('completed');
    expect(result.events).toEqual(['ticket.status_changed']);
    const [eventContext] = engineMock.executeForEvent.mock.calls[0];
    expect(eventContext.event.type).toBe('ticket.status_changed');
    // Phase 8c: the payload carries the status NAMES and their BASES so
    // conditions can match either ("entered Needs Rework" / "entered any
    // Pending-base status").
    expect(eventContext.event.extra).toEqual({
      from: 'Open', to: 'Pending', fromBase: 'Open', toBase: 'Pending',
    });
    expect(eventContext.event.dedupeStamp).toBe('Open->Pending:2026-07-06T10:00:00.000Z');
    expect(eventContext.ticket.statusBase).toBe('Open'); // hydrated ticket is still status Open
  });

  test('custom-status transition carries the registry base (statusBase + toBase)', async () => {
    // Registry knows "Needs Rework" as Pending-base for ws1.
    prismaMock.ticketStatusDefinition = {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
        { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
        { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
        { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
        { id: 5, workspaceId: 1, name: 'Needs Rework', baseStatus: 'Pending', color: 'violet', sortOrder: 4, isSystem: false, isActive: true },
      ]),
    };
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();
    prismaMock.ticket.findUnique.mockResolvedValue({ ...hydratedTicket, status: 'Needs Rework' });

    const result = await emitTicketLifecycleNotifications({
      existingTicket: { id: 501, workspaceId: 1, assignedTechId: null, status: 'Open' },
      upsertedTicket: {
        id: 501,
        workspaceId: 1,
        assignedTechId: null,
        status: 'Needs Rework',
        freshserviceUpdatedAt: new Date('2026-07-06T11:00:00.000Z'),
      },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    });

    // Pending-base custom status is NOT terminal — no resolved_closed event.
    expect(result.events).toEqual(['ticket.status_changed']);
    const [eventContext] = engineMock.executeForEvent.mock.calls[0];
    expect(eventContext.event.extra).toEqual({
      from: 'Open', to: 'Needs Rework', fromBase: 'Open', toBase: 'Pending',
    });
    expect(eventContext.ticket.status).toBe('Needs Rework');
    expect(eventContext.ticket.statusBase).toBe('Pending');

    delete prismaMock.ticketStatusDefinition;
    invalidateStatusCache();
  });

  test('custom Resolved-base status fires resolved_closed (registry-aware terminal)', async () => {
    prismaMock.ticketStatusDefinition = {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
        { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
        { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
        { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
        { id: 6, workspaceId: 1, name: 'Fixed', baseStatus: 'Resolved', color: 'emerald', sortOrder: 5, isSystem: false, isActive: true },
      ]),
    };
    const { invalidateStatusCache } = await import('../src/services/statusService.js');
    invalidateStatusCache();
    prismaMock.ticket.findUnique.mockResolvedValue({ ...hydratedTicket, status: 'Fixed' });

    const result = await emitTicketLifecycleNotifications({
      existingTicket: { id: 501, workspaceId: 1, assignedTechId: null, status: 'Open' },
      upsertedTicket: {
        id: 501,
        workspaceId: 1,
        assignedTechId: null,
        status: 'Fixed',
        resolvedAt: new Date('2026-07-06T12:00:00.000Z'),
        freshserviceUpdatedAt: new Date('2026-07-06T12:00:00.000Z'),
      },
      source: 'ticketpulse_native',
      allowNotificationWorkflows: true,
    });

    expect(result.events).toEqual(['ticket.resolved_closed', 'ticket.status_changed']);

    delete prismaMock.ticketStatusDefinition;
    invalidateStatusCache();
  });

  test('disallowed ingest paths do not dispatch', async () => {
    const result = await emitTicketLifecycleNotifications({
      existingTicket: { id: 501, status: 'Open' },
      upsertedTicket: { id: 501, status: 'Pending' },
      allowNotificationWorkflows: false,
    });
    expect(result.status).toBe('skipped');
    expect(engineMock.executeForEvent).not.toHaveBeenCalled();
  });
});
