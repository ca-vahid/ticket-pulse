import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Mail review: attaching a held mail keeps its author right (11 Nov 2026).
 *
 * Most held mail is an agent's own (possible_follow_up, agent_reply_no_requester).
 * mailboxHoldService.attach called the reply ingest without the agent, so that
 * mail was stored as an incoming requester-style reply from the agent's address
 * and fired ticket.reply_received: the ticket reopened and people were told a
 * customer had replied.
 *
 * Here the REAL hold service and the REAL reply ingest run against a mocked
 * database: who wrote the mail (an agent of the workspace, or a requester) by
 * reopen yes / no on a closed ticket. Every name is invented.
 */

const prismaMock = {
  mailboxHeldMessage: { findFirst: jest.fn(), update: jest.fn() },
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
const copyMock = { copyAgentsOnRequesterReply: jest.fn() };
const mirrorMock = { enqueueThreadEntry: jest.fn(), enqueueFieldSync: jest.fn(), getInteractiveClient: jest.fn(async () => null) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => true), getMessageAttachments: jest.fn(async () => []) } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn(), addPrivateNote: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: mirrorMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/autoHelpReplyOwner.js', () => replyOwnerMock);
jest.unstable_mockModule('../src/services/watcherNotificationService.js', () => ({ default: { notify: jest.fn(() => Promise.resolve()) } }));
jest.unstable_mockModule('../src/services/requesterReplyCopyService.js', () => copyMock);
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(async () => null), set: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, name) => (['Closed', 'Resolved'].includes(name) ? name : 'Open')) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: mailboxHoldService } = await import('../src/services/mailboxHoldService.js');

const WS = 2;
const connection = { id: 1, workspaceId: WS, address: 'artickets@example.org' };
const AGENT = { id: 59, name: 'Pat Agent', email: 'pat.agent@example.org' };
const ACTOR = { email: 'ari@example.org', name: 'Ari Agent', role: 'agent', technicianId: 3 };
const ticket = (over = {}) => ({
  id: 7001, workspaceId: WS, origin: 'ticketpulse', nativeNumber: 812, requesterId: 501, status: 'Closed', ccEmails: [],
  createdAt: new Date('2026-10-20T17:00:00Z'), firstPublicAgentReplyAt: null, replyOwner: null, requester: { id: 501, email: 'robin.vale@client.example', name: 'Robin Vale' }, ...over,
});
function heldRow(from, fromName) {
  return {
    id: 501, workspaceId: WS, connectionId: 1, connection, status: 'held', reason: 'possible_follow_up', internetMessageId: '<follow-up-1@mail.example>',
    fromEmail: from, fromName, toEmails: ['robin.vale@client.example'], ccEmails: ['artickets@example.org'],
    subject: 'RE: Reminder: 85 Days Outstanding Invoice - 4053377 - Northwind Traders', snippet: 'Any update on this invoice?', bodyHtml: '<p>Any update on this invoice?</p>',
    emailPayload: { id: 'AAMk-1', bodyText: 'Any update on this invoice?', internetMessageId: '<follow-up-1@mail.example>', receivedAt: '2026-11-10T20:36:00.000Z' },
    receivedAt: new Date('2026-11-10T20:36:00Z'),
  };
}

const events = () => lifecycleMock.emitTicketEvent.mock.calls.map((c) => c[0]);
const entryData = () => prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;

async function attach({ from, fromName, status = 'Closed', reopen = null, ticketOver = {} }) {
  const t = ticket({ status, ...ticketOver });
  prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue(heldRow(from, fromName));
  prismaMock.ticket.findFirst.mockResolvedValue(t);
  return mailboxHoldService.attach(501, t.id, ACTOR, { workspaceId: WS, ...(reopen === null ? {} : { reopen }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.mailboxHeldMessage.update.mockImplementation(({ data }) => Promise.resolve({ id: 501, workspaceId: WS, ...data }));
  prismaMock.mailboxConnection.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: 9001, ...data }));
  prismaMock.ticketThreadEntry.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticket.findUnique.mockResolvedValue(null);
  prismaMock.requester.findUnique.mockResolvedValue({ email: 'robin.vale@client.example' });
  // The ingest's own test for "an agent of this workspace": an active technician with that address.
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => {
    const email = String(where?.email?.equals || '').toLowerCase();
    return where?.workspaceId === WS && where?.isActive === true && email === AGENT.email ? { ...AGENT } : null;
  });
  prismaMock.technician.findMany.mockResolvedValue([]);
  activityMock.create.mockResolvedValue({});
  lifecycleMock.emitTicketEvent.mockResolvedValue(undefined);
  replyOwnerMock.claimForAgentReply.mockResolvedValue({ superseded: [] });
  copyMock.copyAgentsOnRequesterReply.mockResolvedValue({ sent: true });
  mirrorMock.enqueueThreadEntry.mockResolvedValue({});
});

describe('an agent’s own mail, attached from hold', () => {
  for (const [label, reopen] of [['reopen yes', true], ['reopen no', false]]) {
    test(`${label}: the agent's public reply, already delivered, counted for first response, with no "requester replied"`, async () => {
      const result = await attach({ from: 'Pat.Agent@example.org', fromName: 'Pat Agent', reopen });

      expect(entryData()).toMatchObject({
        ticketId: 7001, source: 'email_inbound', eventType: 'reply', authorType: 'agent', actorName: 'Pat Agent', actorEmail: 'pat.agent@example.org',
        incoming: false, isPrivate: false, visibility: 'public', emailMessageId: '<follow-up-1@mail.example>',
      });
      // Already delivered by Outlook: nothing sends the reply again.
      expect(entryData().rawPayload).toMatchObject({ deliveryState: 'external', agentIntake: { kind: 'agent_reply_email', technicianId: 59, via: 'held_reply_attach' } });
      expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'agent_reply', details: expect.objectContaining({ deliveryState: 'external', technicianId: 59 }) }));
      // No "requester replied": no reopen workflow, no "new request" follow-up, no copy to the assignee.
      expect(events()).toEqual(['ticket.public_reply_added']);
      expect(lifecycleMock.emitTicketEvent.mock.calls[0][2].extra).toMatchObject({ alreadyDelivered: true, via: 'outlook', byEmail: 'pat.agent@example.org', isPrivate: false });
      expect(copyMock.copyAgentsOnRequesterReply).not.toHaveBeenCalled();
      // Counted as the first response, at the time Outlook delivered it.
      expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({ where: { id: 7001, firstPublicAgentReplyAt: null }, data: { firstPublicAgentReplyAt: new Date('2026-11-10T20:36:00.000Z') } });
      // The hold queue changes no status: reopening is the explicit status change Mail triage makes (mailTriageService._reopen).
      expect(prismaMock.ticket.update.mock.calls.every((c) => !('status' in c[0].data))).toBe(true);
      expect(result.held.status).toBe('attached');
      expect(result.entry.authorType).toBe('agent');
    });
  }

  test('on an open ticket, with no reopen answer (the old dialog): the same agent reply', async () => {
    await attach({ from: 'pat.agent@example.org', fromName: 'Pat Agent', status: 'Open' });
    expect(entryData()).toMatchObject({ authorType: 'agent', incoming: false });
    expect(events()).toEqual(['ticket.public_reply_added']);
  });

  test('an agent who is this ticket’s requester writes as the requester (identity is per ticket)', async () => {
    prismaMock.requester.findUnique.mockResolvedValue({ email: 'pat.agent@example.org' });
    await attach({ from: 'pat.agent@example.org', fromName: 'Pat Agent', status: 'Open' });
    expect(entryData()).toMatchObject({ authorType: 'requester', incoming: true });
    expect(events()).toEqual(['ticket.reply_received']);
  });
});

describe('a requester’s mail, attached from hold, keeps today’s behaviour', () => {
  test('reopen yes (and no answer at all): an incoming reply that fires "requester replied" and copies the assignee', async () => {
    for (const reopen of [true, null]) {
      jest.clearAllMocks();
      await attach({ from: 'robin.vale@client.example', fromName: 'Robin Vale', reopen });
      expect(entryData()).toMatchObject({ authorType: 'requester', actorEmail: 'robin.vale@client.example', incoming: true, isPrivate: false });
      expect(entryData().rawPayload?.deliveryState).toBeUndefined();
      expect(entryData().rawPayload?.keepClosed).toBeUndefined();
      expect(events()).toEqual(['ticket.reply_received']);
      expect(lifecycleMock.emitTicketEvent.mock.calls[0][2]).toMatchObject({ source: 'email_inbound', extra: { from: 'robin.vale@client.example', via: 'held_reply_attach' } });
      expect(copyMock.copyAgentsOnRequesterReply).toHaveBeenCalledTimes(1);
      expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled(); // not a first response
      expect(activityMock.create).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'requester_reply' }));
    }
  });

  test('reopen no: added quietly, no "requester replied", the ticket stays closed; the assignee still gets the copy', async () => {
    await attach({ from: 'robin.vale@client.example', fromName: 'Robin Vale', reopen: false });
    expect(entryData()).toMatchObject({ authorType: 'requester', incoming: true });
    expect(entryData().rawPayload).toMatchObject({ keepClosed: true });
    expect(events()).toEqual([]);
    expect(copyMock.copyAgentsOnRequesterReply).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.update.mock.calls.every((c) => !('status' in c[0].data))).toBe(true);
  });

  test('somebody who is not an agent of THIS workspace is a requester, whatever they are elsewhere', async () => {
    prismaMock.technician.findFirst.mockImplementation(async ({ where }) => (where?.workspaceId === 1 ? { ...AGENT } : null));
    await attach({ from: 'pat.agent@example.org', fromName: 'Pat Agent', status: 'Open' });
    expect(entryData()).toMatchObject({ authorType: 'requester', incoming: true });
  });
});
