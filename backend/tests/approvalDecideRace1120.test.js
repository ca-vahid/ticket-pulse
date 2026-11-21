import { jest } from '@jest/globals';

/**
 * 20 Nov 2026: a person deciding at the same moment the ticket closes. _decide
 * reads the row, then looks up a name and a signature before it writes. If the
 * ticket closed in between (and ended the approval as not needed), the write
 * must not overwrite that close: it only writes a row that is still open, and
 * on a miss nothing else runs (no e-mail, no Assetron assign, no note, no
 * workflow event) and the caller gets a 409.
 */

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  approvalCategory: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketApproval: {
    findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(),
  },
  ticketThreadEntry: { create: jest.fn() },
  technician: { findFirst: jest.fn() },
  requester: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const lifecycleMock = { emitTicketEvent: jest.fn() };
const mailMock = { sendTransactionalEmail: jest.fn(), deliverTransactionalEmail: jest.fn() };
const assetronMock = { touch: jest.fn(), forGroup: jest.fn(async () => []) };
const teamsMock = { refreshApprovalCards: jest.fn(), notifyApproval: jest.fn() };
const conversationMock = { signatureFor: jest.fn(async () => null) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ ...mailMock, default: mailMock }));
jest.unstable_mockModule('../src/services/assetronReservationService.js', () => ({ default: assetronMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teamsMock }));
jest.unstable_mockModule('../src/services/approvalConversationService.js', () => ({ default: conversationMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/personDirectoryService.js', () => ({ resolvePersonName: jest.fn(async () => null) }));

const { default: ticketApprovalService, CLOSED_BY_TICKET_MESSAGE } = await import('../src/services/ticketApprovalService.js');

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const row = (over = {}) => ({
  id: 173, ticketId: 65083, workspaceId: 1, status: 'pending', approverEmail: 'dana.fox@example.com', approverName: 'Dana Fox',
  requestedBy: 'sam.okafor@example.com', requestGroupId: 'grp-1', tier: 1, isFinal: false, amount: null, conditions: null, ...over,
});
const closedByTicket = row({ status: 'closed', closeReason: 'not_needed', decidedVia: 'ticket_closed', decidedAt: new Date(), decisionNote: 'Not needed any more: the ticket was closed without a decision.' });
const notFound = () => Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
const actor = { email: 'dana.fox@example.com', name: 'Dana Fox' };

function expectNothingElse() {
  expect(mailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  expect(assetronMock.touch).not.toHaveBeenCalled();
  expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  expect(activityMock.create).not.toHaveBeenCalled();
  expect(lifecycleMock.emitTicketEvent).not.toHaveBeenCalled();
  expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled(); // siblings left alone
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ id: 65083, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 10648, status: 'Closed', subject: 'Licence' });
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  activityMock.create.mockResolvedValue({});
});

describe('a decision that loses the race to a ticket close', () => {
  test('the write only matches a row that is still open', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    prismaMock.ticketApproval.update.mockImplementation(async ({ where, data }) => ({ ...row(), ...data, id: where.id }));
    await ticketApprovalService.decideInApp(65083, 1, 173, 'approved', null, actor);
    expect(prismaMock.ticketApproval.update.mock.calls[0][0].where).toEqual({ id: 173, status: { in: ['pending', 'info_requested'] } });
  });

  test('closed by the ticket between the read and the write: 409, nothing recorded or sent', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row()); // read while still pending
    prismaMock.ticketApproval.update.mockRejectedValue(notFound()); // the close got there first
    prismaMock.ticketApproval.findUnique.mockResolvedValue(closedByTicket);
    const err = await ticketApprovalService.decideInApp(65083, 1, 173, 'approved', 'Go ahead', actor).catch((e) => e);
    await flush();
    expect(err).toMatchObject({ statusCode: 409, code: 'approval_closed_by_ticket', message: CLOSED_BY_TICKET_MESSAGE });
    expect(CLOSED_BY_TICKET_MESSAGE).toMatch(/^This approval was closed because the ticket closed\./);
    expectNothingElse();
  });

  test('the same from the e-mail link', async () => {
    prismaMock.ticketApproval.findUnique
      .mockResolvedValueOnce({ ...row(), tokenHash: 'h', expiresAt: null }) // _findByToken
      .mockResolvedValueOnce(closedByTicket); // the re-read after the miss
    prismaMock.ticketApproval.update.mockRejectedValue(notFound());
    const err = await ticketApprovalService.decideByToken('t'.repeat(40), 'rejected', 'No budget').catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'approval_closed_by_ticket' });
    expectNothingElse();
  });

  test('a row already closed by the ticket is refused before anything is looked up', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(closedByTicket);
    const err = await ticketApprovalService.decideInApp(65083, 1, 173, 'approved', null, actor).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'approval_closed_by_ticket' });
    expect(prismaMock.ticketApproval.update).not.toHaveBeenCalled();
    expectNothingElse();
  });

  test('another approver got there first: a plain 409 naming the state', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    prismaMock.ticketApproval.update.mockRejectedValue(notFound());
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ status: 'rejected', decidedVia: 'link' }));
    const err = await ticketApprovalService.decideInApp(65083, 1, 173, 'approved', null, actor).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, message: 'This approval was already rejected' });
    expect(err.code).toBeUndefined();
    expectNothingElse();
  });

  test('any other database error still surfaces as itself', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    prismaMock.ticketApproval.update.mockRejectedValue(new Error('db down'));
    await expect(ticketApprovalService.decideInApp(65083, 1, 173, 'approved', null, actor)).rejects.toThrow('db down');
  });
});
