import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * FR 09-11 #1 — "The State column should show a tag when the requester replies.
 * I tested this with Alvina, but the ticket did not update."
 *
 * It did not, because the tester IS the ticket's requester AND an active agent
 * in the same workspace. Production, TP-1291:
 *
 *   sxu@bgcengineering.ca  in=false  author=agent   reply   <-- the requester
 *
 * `resolveAgentSender` runs BEFORE the matching ladder, so it can only answer
 * "is this person an agent in this workspace" — never "whose ticket is this".
 * Identity has to be settled per ticket: on your own ticket you are the
 * customer, whatever your job title. Forwards stay agent actions.
 */

const prismaMock = {
  mailboxConnection: { findMany: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  requester: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationDelivery: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const lifecycleMock = { emitTicketEvent: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: { isConfigured: jest.fn(() => true), getInboxMessagesForIngest: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({
  default: { notify: jest.fn(() => Promise.resolve()) },
}));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({
  default: { holdMessage: jest.fn(), isKnownMessageId: jest.fn() },
}), { virtual: true });
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc } = await import('../src/services/mailboxIngestService.js');

const connection = { id: 1, workspaceId: 5, address: 'patickets@bgcengineering.ca' };
// TP-1291, as it exists in production.
const ticket = {
  id: 44409, workspaceId: 5, origin: 'ticketpulse', nativeNumber: 1291,
  requesterId: 2511, status: 'Closed', ccEmails: [],
};
// Susan Xu: the ticket's requester, and an active ws5 technician.
const susanAsAgent = { id: 3271311, name: 'Susan Xu', email: 'sxu@bgcengineering.ca' };
const alvinaAsAgent = { id: 4075676, name: 'Alvina Ho', email: 'aho@bgcengineering.ca' };

const mail = (from, over = {}) => ({
  id: 'msg-' + from, subject: 'RE: A-Code Setup', from, fromName: from,
  receivedAt: new Date('2026-09-11T21:20:12Z'),
  bodyHtml: '<p>Any update?</p>', bodyText: 'Any update?', bodyPreview: 'Any update?',
  internetMessageId: '<x@bgcengineering.ca>', inReplyTo: null, references: null, ...over,
});

const lastEntry = () => prismaMock.ticketThreadEntry.create.mock.calls.at(-1)[0].data;

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticketThreadEntry.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  activityMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketEvent.mockResolvedValue(undefined);
  // The ticket's requester is Susan.
  prismaMock.requester.findUnique.mockResolvedValue({ email: 'sxu@bgcengineering.ca' });
});

describe('on your own ticket you are the requester, whatever your job title', () => {
  test('an agent who is THIS ticket\'s requester files as a requester reply', async () => {
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'plus_address', { agent: susanAsAgent });
    const e = lastEntry();
    expect(e.authorType).toBe('requester');
    expect(e.incoming).toBe(true);
    // Her name, not a technician record, and no agent-reply delivery marker.
    expect(e.actorEmail).toBe('sxu@bgcengineering.ca');
    expect(e.rawPayload?.deliveryState).toBeUndefined();
  });

  test('...so the reply drives the State tag and the reopen workflow', async () => {
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'plus_address', { agent: susanAsAgent });
    // `ticket.reply_received` is what the seeded reopen workflow listens to.
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith(
      'ticket.reply_received', ticket.id, expect.anything(),
    );
    expect(activityMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ activityType: 'requester_reply' }),
    );
  });

  test('a real agent reply is unchanged — still an agent reply, not incoming', async () => {
    await svc.ingestReply(connection, ticket, mail('aho@bgcengineering.ca'), 'cc', { agent: alvinaAsAgent });
    const e = lastEntry();
    expect(e.authorType).toBe('agent');
    expect(e.incoming).toBe(false);
    expect(e.rawPayload.deliveryState).toBe('external');
    // An agent's own Outlook reply must NOT look like a requester replying.
    expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
  });

  test('a plain requester who is not an agent is unchanged', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ email: 'csimpson@bgcengineering.ca' });
    await svc.ingestReply(connection, ticket, mail('csimpson@bgcengineering.ca'), 'plus_address', { agent: null });
    const e = lastEntry();
    expect(e.authorType).toBe('requester');
    expect(e.incoming).toBe(true);
  });

  test('an agent replying to somebody ELSE\'s ticket stays an agent', async () => {
    // Requester is Chelsea; Susan is just an agent here.
    prismaMock.requester.findUnique.mockResolvedValue({ email: 'csimpson@bgcengineering.ca' });
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'cc', { agent: susanAsAgent });
    expect(lastEntry().authorType).toBe('agent');
  });

  test('matching is case- and whitespace-insensitive', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ email: '  SXU@BGCengineering.ca ' });
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'plus_address', { agent: susanAsAgent });
    expect(lastEntry().authorType).toBe('requester');
  });
});

describe('forwards are left alone', () => {
  const fwdCtx = {
    originalOk: true,
    parsed: {
      isForward: true,
      original: {
        email: 'csimpson@bgcengineering.ca',
        name: 'Chelsea Simpson',
        date: new Date('2026-08-17T08:26:00Z'),
        dateRaw: 'Monday, August 17, 2026 8:26 AM',
        to: ['projectaccounting@bgcengineering.ca'],
        cc: [],
        subject: 'A-Code Setup - Santiago Office Move',
      },
    },
  };

  test('an agent forwarding a ticket they requested is still a forward', async () => {
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'body_ref', { agent: susanAsAgent, ctx: fwdCtx });
    const e = lastEntry();
    expect(e.authorType).toBe('agent');
    expect(e.rawPayload.forwarded).toBeTruthy();
    // A forward carries somebody else's words, so it IS incoming...
    expect(e.incoming).toBe(true);
    // ...and must not be labelled as the agent's own outbound reply.
    expect(e.rawPayload.deliveryState).toBeUndefined();
  });
});

describe('the identity lookup never costs a reply', () => {
  test('a database failure falls back to the old behaviour instead of throwing', async () => {
    prismaMock.requester.findUnique.mockRejectedValue(new Error('connection reset'));
    await expect(
      svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'plus_address', { agent: susanAsAgent }),
    ).resolves.toBeDefined();
    expect(lastEntry().authorType).toBe('agent'); // pre-09-11 answer, but stored
  });

  test('a ticket with no requester is not treated as a match', async () => {
    await svc.ingestReply(connection, { ...ticket, requesterId: null }, mail('sxu@bgcengineering.ca'), 'cc', { agent: susanAsAgent });
    expect(lastEntry().authorType).toBe('agent');
    expect(prismaMock.requester.findUnique).not.toHaveBeenCalled();
  });

  test('a requester row with no e-mail is not a match for an empty sender', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ email: null });
    await svc.ingestReply(connection, ticket, mail('sxu@bgcengineering.ca'), 'cc', { agent: susanAsAgent });
    expect(lastEntry().authorType).toBe('agent');
  });
});
