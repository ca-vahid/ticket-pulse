import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * QA 11-05b #3 (Vahid) — an agent's reply from Outlook fires "Agent replied to
 * requester" (`ticket.public_reply_added`), the event the in-app reply fires
 * (ticketService._addThreadEntry), with guards:
 *  (a) once per thread entry: the dedupe stamp is `reply:<entryId>`;
 *  (b) `via: 'outlook'`, `alreadyDelivered: true` — nothing re-sends it
 *      (the engine side is in outlookReplyDeliveredGuard.test.js);
 *  (c) FS-born: fired once here; the FS write-back of the note fires nothing
 *      (and the FS sync never emits this event — see that file);
 *  (d) the agent rides on the event (byEmail + actorTechnicianId), so the
 *      Teams teammate update skips them (teamsNotificationService.test.js);
 *  (e) never ticket.reply_received.
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
const fsClient = { addNote: jest.fn(async () => ({ id: 1 })) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: { isConfigured: jest.fn(() => true), getInboxMessagesForIngest: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn(), getInteractiveClient: jest.fn(async () => fsClient) },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/autoHelpReplyOwner.js', () => replyOwnerMock);
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({
  default: { notify: jest.fn(() => Promise.resolve()) },
}));
jest.unstable_mockModule('../src/services/requesterReplyCopyService.js', () => ({ copyAgentsOnRequesterReply: jest.fn() }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc } = await import('../src/services/mailboxIngestService.js');

const connection = { id: 1, workspaceId: 1, address: 'helpdesk@example.com' };
const ticket = (over = {}) => ({
  id: 70001, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 11358,
  requesterId: 501, status: 'Open', ccEmails: [], createdAt: new Date('2026-11-06T00:22:00Z'), firstPublicAgentReplyAt: null, replyOwner: null, ...over,
});
const agent = { id: 59, name: 'Alex Rivera', email: 'arivera@example.com' };
const mail = (from, over = {}) => ({
  id: `msg-${Math.random()}`, subject: 'RE: Monitor flickering', from, fromName: from,
  receivedAt: new Date('2026-11-06T01:09:00Z'),
  bodyHtml: '<p>On my way with a new cable.</p>', bodyText: 'On my way with a new cable.', bodyPreview: 'On my way with a new cable.',
  internetMessageId: `<reply-${Math.random()}@example.com>`, inReplyTo: '<orig@example.com>', references: null, ...over,
});
let nextEntry = 9001;
const events = () => lifecycleMock.emitTicketEvent.mock.calls;
const replyAdded = () => events().filter((c) => c[0] === 'ticket.public_reply_added');

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: nextEntry++, ...data }));
  prismaMock.ticketThreadEntry.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
  activityMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketEvent.mockResolvedValue(undefined);
  replyOwnerMock.claimForAgentReply.mockResolvedValue({ superseded: [] });
  prismaMock.requester.findUnique.mockResolvedValue({ email: 'sam.ortiz@example.com' });
});

describe('an agent reply from Outlook fires "Agent replied to requester"', () => {
  test('the in-app payload shape, plus via outlook / alreadyDelivered, the agent, and never reply_received (b, d, e)', async () => {
    const entry = await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(events().map((c) => c[0])).toEqual(['ticket.public_reply_added']); // (e) no reply_received
    const [, ticketId, opts] = replyAdded()[0];
    expect(ticketId).toBe(70001);
    expect(opts).toMatchObject({
      source: 'email_inbound',
      dedupeStamp: `reply:${entry.id}`,
      extra: expect.objectContaining({
        entryId: entry.id,
        byEmail: 'arivera@example.com',
        actorTechnicianId: 59,
        ref: 'TP-11358',
        author: 'Alex Rivera',
        authorType: 'agent',
        isPrivate: false,
        bodyText: 'On my way with a new cable.',
        via: 'outlook',
        alreadyDelivered: true,
        matchedVia: 'threading_headers',
      }),
    });
    expect(opts.extra.occurredAt).toBe('2026-11-06T01:09:00.000Z');
  });

  test('(a) once per thread entry: one event per ingested reply, each stamped with its own entry id', async () => {
    const a = await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    const b = await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(replyAdded().map((c) => c[2].dedupeStamp)).toEqual([`reply:${a.id}`, `reply:${b.id}`]);
    // The stamp is the in-app path's shape (ticketService: `reply:${entry.id}`), so the engine's delivery dedupe treats a retry as the same event.
    expect(new Set(replyAdded().map((c) => c[2].dedupeStamp)).size).toBe(2);
  });

  test('(c) FS-born: fired once; the reply is written to FreshService as a note, which fires nothing more', async () => {
    await svc.ingestReply(connection, ticket({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 250847n }), mail(agent.email), 'threading_headers', { agent });
    expect(fsClient.addNote).toHaveBeenCalledTimes(1);
    expect(replyAdded()).toHaveLength(1);
    expect(replyAdded()[0][2].extra.ref).toBe('#250847');
  });

  test('requester replies, agent forwards and an agent who is the requester do not fire it', async () => {
    await svc.ingestReply(connection, ticket(), mail('sam.ortiz@example.com'), 'threading_headers', { agent: null });
    const ctx = {
      originalOk: true,
      parsed: { isForward: true, original: { email: 'sam.ortiz@example.com', name: 'Sam Ortiz', date: new Date('2026-11-05T20:00:00Z'), dateRaw: 'Thu', to: [], cc: [], subject: 'Monitor' } },
    };
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'body_ref', { agent, ctx });
    prismaMock.requester.findUnique.mockResolvedValue({ email: agent.email });
    await svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent });
    expect(replyAdded()).toHaveLength(0);
    expect(events().every((c) => c[0] === 'ticket.reply_received')).toBe(true);
  });

  test('a failed dispatch never costs the reply', async () => {
    lifecycleMock.emitTicketEvent.mockRejectedValue(new Error('engine down'));
    await expect(svc.ingestReply(connection, ticket(), mail(agent.email), 'threading_headers', { agent })).resolves.toMatchObject({ authorType: 'agent' });
  });
});
