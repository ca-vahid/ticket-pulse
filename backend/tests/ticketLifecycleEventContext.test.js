import { jest } from '@jest/globals';

// QA 08-06 #4 — the workflow event context must carry the origin-safe ticket
// number: displayRef ("TP-1070" / "#225001") and nativeNumber, so templates
// stop rendering blank {{ ticket.freshserviceTicketId }} on TP-born tickets.

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  technician: { findUnique: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({
  default: { executeForEvent: jest.fn() },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { listStatuses: jest.fn().mockResolvedValue([]) },
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
}));

const { buildEventContext } = await import('../src/services/ticketLifecycleNotificationService.js');

const baseEvent = {
  type: 'ticket.created',
  occurredAt: '2026-08-06T18:00:00.000Z',
  dedupeStamp: 'stamp',
  notificationFingerprint: 'fp',
};

function baseTicket(overrides = {}) {
  return {
    id: 4821,
    workspaceId: 1,
    workspace: { name: 'IT', defaultTimezone: 'America/Vancouver' },
    subject: 'Field card request',
    descriptionText: 'Status: <Processed>',
    status: 'Open',
    priority: 2,
    origin: 'ticketpulse',
    nativeNumber: 1070,
    freshserviceTicketId: null,
    source: 100,
    ticketType: 'Case',
    customFields: { client_name: 'ACME' },
    tagLinks: [],
    requester: { id: 40, name: 'Rita', email: 'rita@example.com' },
    assignedTech: null,
    ...overrides,
  };
}

describe('buildEventContext ticket number fields (QA 08-06 #4)', () => {
  test('TP-born tickets expose displayRef TP-<n> and nativeNumber; FS id stays null', () => {
    const context = buildEventContext({ event: baseEvent, ticket: baseTicket(), previousAgent: null, source: 'ticketpulse_native' });
    expect(context.ticket.displayRef).toBe('TP-1070');
    expect(context.ticket.nativeNumber).toBe(1070);
    expect(context.ticket.freshserviceTicketId).toBeNull();
    expect(context.ticket.origin).toBe('ticketpulse');
    // Raw plain-text description keeps its bracketed token for templates.
    expect(context.ticket.descriptionText).toBe('Status: <Processed>');
  });

  test('FS-born tickets expose displayRef #<fsId> and a null nativeNumber', () => {
    const context = buildEventContext({
      event: baseEvent,
      ticket: baseTicket({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 225001n }),
      previousAgent: null,
      source: 'freshservice_sync',
    });
    expect(context.ticket.displayRef).toBe('#225001');
    expect(context.ticket.nativeNumber).toBeNull();
    expect(context.ticket.freshserviceTicketId).toBe('225001');
  });
});
