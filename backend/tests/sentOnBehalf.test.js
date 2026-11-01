import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * QA 10-30 #7 — a delegate's mail "FW: Office roundtable" was
 * written by Alex Delegate from Pat Manager's mailbox as his delegate:
 *
 *   From:   "Pat Manager" <pmanager@example.com>
 *   Sender: "Alex Delegate" <adelegate@example.com>
 *
 * Ticket Pulse read only From, so Pat became the requester. The person who
 * wrote the mail is the Sender.
 */

const prismaMock = {
  mailboxConnection: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  requester: { findUnique: jest.fn() },
};
const agentMock = { resolveAgentSender: jest.fn(), prepareAgentContext: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/agentIntakeService.js', () => ({ default: agentMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { createTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc } = await import('../src/services/mailboxIngestService.js');
const { mapGraphMessageForIngest, INGEST_MESSAGE_SELECT } = await import('../src/integrations/graphMailClient.js');

const connection = { id: 1, workspaceId: 1, address: 'it@example.com' };
const delegateMail = {
  id: 'AAMk', subject: 'FW: Office roundtable',
  from: 'pmanager@example.com', fromName: 'Pat Manager',
  sender: 'adelegate@example.com', senderName: 'Alex Delegate',
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  agentMock.resolveAgentSender.mockResolvedValue(null);
});

describe('mail sent on someone\'s behalf', () => {
  test('Graph is asked for the Sender, and the mapping keeps it', () => {
    expect(INGEST_MESSAGE_SELECT.split(',')).toContain('sender');
    const email = mapGraphMessageForIngest({
      id: 'x', receivedDateTime: '2026-10-30T19:49:49Z',
      from: { emailAddress: { address: 'pmanager@example.com', name: 'Pat Manager' } },
      sender: { emailAddress: { address: 'adelegate@example.com', name: 'Alex Delegate' } },
    });
    expect(email).toMatchObject({ from: 'pmanager@example.com', sender: 'adelegate@example.com', senderName: 'Alex Delegate' });
  });

  test('a delegate's mail: Alex wrote it, Pat is who it was sent for', async () => {
    const email = await svc._creditTheWriter(connection, delegateMail);
    expect(email.from).toBe('adelegate@example.com');
    expect(email.fromName).toBe('Alex Delegate');
    expect(email.onBehalfOf).toEqual({ email: 'pmanager@example.com', name: 'Pat Manager' });
  });

  test('an ordinary mail (Sender = From, or no Sender) is untouched', async () => {
    const same = { ...delegateMail, sender: 'pmanager@example.com' };
    expect(await svc._creditTheWriter(connection, same)).toBe(same);
    const none = { ...delegateMail, sender: '' };
    expect(await svc._creditTheWriter(connection, none)).toBe(none);
  });

  test('sent for one of our own mailboxes, or by an agent: left as it was', async () => {
    const forMailbox = { ...delegateMail, from: 'it+tp123@example.com' };
    expect(await svc._creditTheWriter(connection, forMailbox)).toBe(forMailbox);
    prismaMock.mailboxConnection.findFirst.mockResolvedValueOnce({ id: 3 });
    expect(await svc._creditTheWriter(connection, delegateMail)).toBe(delegateMail);
    agentMock.resolveAgentSender.mockResolvedValueOnce({ id: 59, email: 'adelegate@example.com' });
    expect(await svc._creditTheWriter(connection, delegateMail)).toBe(delegateMail);
  });

  test('a lookup that fails never loses the mail: it is credited to the writer', async () => {
    prismaMock.mailboxConnection.findFirst.mockRejectedValueOnce(new Error('db down'));
    const email = await svc._creditTheWriter(connection, delegateMail);
    expect(email.from).toBe('adelegate@example.com');
  });
});
