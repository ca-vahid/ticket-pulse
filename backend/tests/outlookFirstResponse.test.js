import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * QA 11-05 #1 — an agent's reply from Outlook counts as the first response.
 *
 * TP-11358: the requester mailed the helpdesk, an agent answered from Outlook
 * 47 minutes later with the mailbox in the loop, the reply was filed on the
 * ticket as the agent's (deliveryState external) — and
 * `first_public_agent_reply_at` stayed null, so every first-response number
 * and the SLA chip said "unanswered". The in-app reply stamps it; the
 * Outlook reply now does the same, once.
 */

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const lifecycleMock = { emitTicketEvent: jest.fn() };
const replyOwnerMock = { claimForAgentReply: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: { isConfigured: jest.fn(() => true), getInboxMessagesForIngest: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn(), getInteractiveClient: jest.fn(async () => ({ addNote: jest.fn(async () => ({ id: 1 })) })) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/autoHelpReplyOwner.js', () => replyOwnerMock);
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({
  default: { notify: jest.fn(() => Promise.resolve()) },
}));
jest.unstable_mockModule('../src/services/requesterReplyCopyService.js', () => ({ copyAgentsOnRequesterReply: jest.fn() }));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({
  default: { holdMessage: jest.fn(), isKnownMessageId: jest.fn() },
}), { virtual: true });
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc } = await import('../src/services/mailboxIngestService.js');

const connection = { id: 1, workspaceId: 1, address: 'helpdesk@example.com' };
const createdAt = new Date('2026-11-06T00:22:00Z'); // 4:22 PM PT
const ticket = (over = {}) => ({
  id: 70001, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 11358,
  requesterId: 501, status: 'Open', ccEmails: [], createdAt, firstPublicAgentReplyAt: null, replyOwner: null, ...over,
});
const agent = { id: 59, name: 'Alex Rivera', email: 'arivera@example.com' };
const mail = (from, over = {}) => ({
  id: `msg-${from}-${Math.random()}`, subject: 'RE: Monitor flickering', from, fromName: from,
  receivedAt: new Date('2026-11-06T01:09:00Z'), // 5:09 PM PT
  bodyHtml: '<p>On my way.</p>', bodyText: 'On my way.', bodyPreview: 'On my way.',
  internetMessageId: '<reply@example.com>', inReplyTo: '<orig@example.com>', references: null, ...over,
});

const stamps = () => prismaMock.ticket.updateMany.mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticketThreadEntry.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
  activityMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketEvent.mockResolvedValue(undefined);
  replyOwnerMock.claimForAgentReply.mockResolvedValue({ superseded: [] });
  // The requester is somebody else.
  prismaMock.requester.findUnique.mockResolvedValue({ email: 'sam.ortiz@example.com' });
});

describe('an agent reply from Outlook is the first response', () => {
  test('sets first_public_agent_reply_at to when Outlook delivered it, only while empty', async () => {
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(stamps()).toEqual([{
      where: { id: 70001, firstPublicAgentReplyAt: null },
      data: { firstPublicAgentReplyAt: new Date('2026-11-06T01:09:00Z') },
    }]);
    // The agent takes the reply, as for an in-app reply.
    expect(replyOwnerMock.claimForAgentReply).toHaveBeenCalledWith(70001, expect.objectContaining({ entryId: 9001 }));
    // Still never re-sent, still no "requester replied"; since 4.3.49 (QA
    // 11-05b #3) it is "Agent replied to requester", once.
    expect(lifecycleMock.emitTicketEvent.mock.calls.map((c) => c[0])).toEqual(['ticket.public_reply_added']);
  });

  test('a second reply never moves it: already answered → no write; a race is caught by the conditional update', async () => {
    await svc.ingestReply(connection, ticket({ firstPublicAgentReplyAt: new Date('2026-11-06T01:09:00Z') }), mail(agent.email), 'threading_headers', { agent });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    // The row did not know yet, the database did: the where clause leaves it.
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(stamps()[0].where).toEqual({ id: 70001, firstPublicAgentReplyAt: null });
  });

  test('a requester reply does not set it', async () => {
    await svc.ingestReply(connection, ticket(), mail('sam.ortiz@example.com'), 'threading_headers', { agent: null });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('an agent who is this ticket\'s requester replies as the requester: not a first response', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ email: agent.email });
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('an agent forward does not set it (the words are the requester\'s)', async () => {
    const ctx = {
      originalOk: true,
      parsed: { isForward: true, original: { email: 'sam.ortiz@example.com', name: 'Sam Ortiz', date: new Date('2026-11-05T20:00:00Z'), dateRaw: 'Thu', to: [], cc: [], subject: 'Monitor' } },
    };
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'body_ref', { agent, ctx });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('never before the ticket existed, never in the future', async () => {
    await svc.ingestReply(connection, ticket(), mail(agent.email, { receivedAt: new Date('2026-11-05T23:00:00Z') }), 'threading_headers', { agent });
    expect(stamps()[0].data.firstPublicAgentReplyAt).toEqual(createdAt);
    jest.clearAllMocks();
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();
    await svc.ingestReply(connection, ticket(), mail(agent.email, { receivedAt: new Date(Date.now() + 86400e3) }), 'threading_headers', { agent });
    expect(stamps()[0].data.firstPublicAgentReplyAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamps()[0].data.firstPublicAgentReplyAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('FS-born tickets get the same stamp', async () => {
    await svc.ingestReply(connection, ticket({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 250847n }), mail(agent.email), 'threading_headers', { agent });
    expect(stamps()).toHaveLength(1);
  });

  test('a failed stamp never costs the reply', async () => {
    prismaMock.ticket.updateMany.mockRejectedValue(new Error('connection reset'));
    await expect(svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent })).resolves.toMatchObject({ id: 9001 });
  });
});
