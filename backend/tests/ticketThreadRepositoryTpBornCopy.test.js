import { jest } from '@jest/globals';

/**
 * 13 Oct 2026, 18:08 PT. The daily review's thread hydration read the FreshService copies of
 * Ticket Pulse-born tickets and stored the mirror's own notes as new conversation rows. The note
 * "reply received by e-mail in Ticket Pulse" is flagged incoming in FreshService, so it became a
 * NEW requester reply: seven "Requester replied" events, and the reopen workflow put three closed
 * tickets (TP-1888 among them) back to Open with no new mail.
 */
const prismaMock = {
  ticketThreadEntry: { findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  ticket: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
};
const emitTicketEventMock = jest.fn().mockResolvedValue({ status: 'completed' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { ingestFreshServiceAttachment: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({
  default: { scheduleRefresh: jest.fn() },
}));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: emitTicketEventMock },
  emitTicketEvent: emitTicketEventMock,
}));

const { default: repo, isMirrorEcho } = await import('../src/services/ticketThreadRepository.js');
// The reply event fires after bulkUpsert returns; under full-suite load 15 ms was not always enough.
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 10)); };
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

const TP_BORN = 62973; // TP-1888
const FS_BORN = 62003; // #245828
const row = (over = {}) => ({
  ticketId: TP_BORN, workspaceId: 1, externalEntryId: 'fs-conversation:1043274913', source: 'freshservice_conversation',
  eventType: 'customer_reply', actorName: 'Jeremy Dumais', actorEmail: 'jdumais@example.com', actorFreshserviceId: null,
  incoming: true, isPrivate: false, visibility: 'customer',
  bodyText: 'Jeremy Dumais · reply received by e-mail in Ticket Pulse · TP-1888 [Ticket Pulse mirror] Thanks, it works now.',
  occurredAt: new Date(), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.upsert.mockImplementation(async ({ create }) => ({ id: 1, ...create }));
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id.in.includes(TP_BORN) ? [{ id: TP_BORN }] : []));
});

describe('conversation rows read from the FreshService copy of a Ticket Pulse-born ticket', () => {
  test('are not stored and fire no "Requester replied": the mirror\'s own note is not a new reply', async () => {
    const out = await repo.bulkUpsert([
      row(),
      row({ externalEntryId: 'fs-conversation:2', eventType: 'private_note', incoming: false, isPrivate: true, bodyText: 'Ticket Pulse · copy of a Ticket Pulse ticket · TP-1888 [Ticket Pulse mirror]' }),
      row({ externalEntryId: 'fs-conversation:3', eventType: 'public_reply', incoming: false, bodyText: 'Seifeddine Reguige · reply, already e-mailed to the requester by Ticket Pulse' }),
    ]);
    await flush();
    expect(out).toEqual({ upserted: 0 });
    expect(prismaMock.ticket.findMany).toHaveBeenCalledWith({ where: { id: { in: [TP_BORN] }, origin: 'ticketpulse' }, select: { id: true } });
    expect(prismaMock.ticketThreadEntry.upsert).not.toHaveBeenCalled();
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });

  test('a FreshService-born ticket in the same batch is stored and still fires for a real reply', async () => {
    await repo.bulkUpsert([
      row(),
      row({ ticketId: FS_BORN, externalEntryId: 'fs-conversation:1043276686', bodyText: 'Hi Soheil, I realized that I need access to adobe acrobat.' }),
    ]);
    await until(() => emitTicketEventMock.mock.calls.length > 0);
    await flush();
    const stored = prismaMock.ticketThreadEntry.upsert.mock.calls.map((c) => c[0].create.ticketId);
    expect(stored).toEqual([FS_BORN]);
    expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).toHaveBeenCalledWith('ticket.reply_received', FS_BORN, expect.objectContaining({ dedupeStamp: 'fs-conversation:1043276686' }));
  });

  test('an activity row on a Ticket Pulse-born ticket is still stored, but never speaks for the requester', async () => {
    await repo.bulkUpsert([row({ externalEntryId: 'fs-activity:9', source: 'freshservice_activity' })]);
    await flush();
    expect(prismaMock.ticketThreadEntry.upsert).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });

  test('when the origin cannot be read, nothing changes from before (stored, and a reply fires)', async () => {
    prismaMock.ticket.findMany.mockRejectedValue(new Error('pool timeout'));
    await repo.bulkUpsert([row({ ticketId: FS_BORN })]);
    await until(() => emitTicketEventMock.mock.calls.length > 0);
    expect(prismaMock.ticketThreadEntry.upsert).toHaveBeenCalledTimes(1);
    expect(emitTicketEventMock).toHaveBeenCalledTimes(1);
  });
});

describe('isMirrorEcho (14 Oct 2026, TP-1888 shown twice)', () => {
  test('a FreshService conversation row carrying the mirror line is an echo', () => {
    expect(isMirrorEcho({ source: 'freshservice_conversation', bodyText: 'Jeremy Dumais · reply received by e-mail in Ticket Pulse · TP-1888 [Ticket Pulse mirror] When I click…' })).toBe(true);
    expect(isMirrorEcho({ source: 'freshservice_conversation', bodyText: '', bodyHtml: '<p>[Ticket Pulse mirror]</p>' })).toBe(true);
  });

  test('work typed on the copy and Ticket Pulse rows are kept', () => {
    expect(isMirrorEcho({ source: 'freshservice_conversation', bodyText: 'Hi Jennifer, as we discussed today…' })).toBe(false);
    expect(isMirrorEcho({ source: 'freshservice_reconciliation', bodyText: 'x [Ticket Pulse mirror]' })).toBe(false);
    expect(isMirrorEcho({ source: 'ticketpulse_user', bodyText: 'Hi Jeremy' })).toBe(false);
    expect(isMirrorEcho(null)).toBe(false);
  });
});
