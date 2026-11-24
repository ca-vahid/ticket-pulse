import { jest } from '@jest/globals';

/**
 * 24 Nov 2026 — a mail-in ticket's To/Cc reach the ticket.created workflows in
 * memory (like createdVia), and only the workflows: the webhook and Teams
 * payloads, and the ticket in the context, are exactly as before.
 * Invented names and example.com only.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  technician: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  ticketAssignmentEpisode: { groupBy: jest.fn() },
};
const executeForEventMock = jest.fn().mockResolvedValue({ status: 'completed' });
const dispatchWebhookEvent = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/notificationWorkflowEngine.js', () => ({ default: { executeForEvent: executeForEventMock } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn().mockResolvedValue('Open'), listStatuses: jest.fn().mockResolvedValue([]) },
  TERMINAL_BASE_STATUSES: new Set(['Resolved', 'Closed']),
}));
jest.unstable_mockModule('../src/services/webhookDispatchService.js', () => ({ default: { dispatchWebhookEvent }, dispatchWebhookEvent }));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({ default: { refreshForTicket: jest.fn(), maybeRefresh: jest.fn() } }));

const { emitTicketLifecycleNotifications } = await import('../src/services/ticketLifecycleNotificationService.js');

const baseTicket = {
  id: 42, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1204, subject: 'Shared drive access', status: 'Open', priority: 2,
  source: 1, toEmails: [], ccEmails: [], replyCcEmails: [],
  requester: { id: 1, name: 'Dana Fox', email: 'dana.fox@example.com' }, workspace: { id: 5, name: 'IT' }, tagLinks: [],
};
const mail = { toEmails: ['it@example.com', 'priya.nair@example.com'], ccEmails: ['lead@example.com'], viaMailbox: true };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue(baseTicket); // re-hydration drops in-memory fields
});

test('ticket.created hands the e-mail\'s To/Cc to the workflows; the ticket in the context is unchanged', async () => {
  await emitTicketLifecycleNotifications({
    existingTicket: null,
    upsertedTicket: { ...baseTicket, createdVia: 'email', originalEmailRecipients: mail },
    source: 'ticketpulse_native',
    allowNotificationWorkflows: true,
  });
  expect(executeForEventMock).toHaveBeenCalledTimes(1);
  const [ctx] = executeForEventMock.mock.calls[0];
  expect(ctx.event.type).toBe('ticket.created');
  expect(ctx.originalEmailRecipients).toEqual(mail);
  expect(ctx.ticket.toEmails).toEqual([]);
  expect(ctx.ticket.ccEmails).toEqual([]);
});

test('without it (app, API, FreshService) the context has no such key', async () => {
  await emitTicketLifecycleNotifications({
    existingTicket: null, upsertedTicket: { ...baseTicket }, source: 'ticketpulse_native', allowNotificationWorkflows: true,
  });
  expect(executeForEventMock.mock.calls[0][0]).not.toHaveProperty('originalEmailRecipients');
});

test('the lifecycle webhook never carries it', async () => {
  await emitTicketLifecycleNotifications({
    existingTicket: null,
    upsertedTicket: { ...baseTicket, originalEmailRecipients: mail },
    source: 'ticketpulse_native',
    allowNotificationWorkflows: true,
  });
  for (const call of dispatchWebhookEvent.mock.calls) {
    expect(JSON.stringify(call)).not.toContain('priya.nair@example.com');
  }
});
