import { jest } from '@jest/globals';

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  approvalCategory: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketApproval: {
    findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(),
  },
  ticketThreadEntry: { create: jest.fn() },
  mailboxConnection: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const sendgridMock = { sendEmail: jest.fn().mockResolvedValue({ status: 'ok' }) };
const graphMock = { isConfigured: () => false };
const lifecycleMock = { emitTicketEvent: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock, sendEmail: sendgridMock.sendEmail }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');

const ticket = { id: 501, workspaceId: 1, origin: 'ticketpulse', subject: 'New laptop', requester: { name: 'Rita' } };

beforeEach(() => {
  jest.clearAllMocks();
  activityMock.create.mockResolvedValue({});
  sendgridMock.sendEmail.mockResolvedValue({ status: 'ok' });
  prismaMock.ticket.findFirst.mockResolvedValue(ticket);
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null); // → sendgrid path
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 1 });
  let seq = 100;
  prismaMock.ticketApproval.create.mockImplementation(({ data }) => Promise.resolve({ id: ++seq, ...data }));
  prismaMock.ticketApproval.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
});

describe('ticketApprovalService.request (category fan-out)', () => {
  test('creates one approval per manager sharing a requestGroupId', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io', 'bob@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null); // no open group

    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'pls' }, { email: 'req@x.io' });

    expect(prismaMock.ticketApproval.create).toHaveBeenCalledTimes(2);
    const groups = prismaMock.ticketApproval.create.mock.calls.map((c) => c[0].data.requestGroupId);
    expect(groups[0]).toBe(groups[1]);
    expect(groups[0]).toBeTruthy();
    expect(res.count).toBe(2);
    // Both managers emailed (mailbox unconfigured → sendgrid).
    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(2);
    // Workflow event dispatched — approval workflows must actually fire.
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith(
      'approval.requested', 501, expect.objectContaining({ extra: expect.any(Object) }),
    );
  });

  test('rejects a category with no managers', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Empty', managerEmails: [] });
    await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 9 }, { email: 'req@x.io' }))
      .rejects.toThrow(/no approval managers/i);
  });

  test('rejects a duplicate open request for the same category', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 1 }); // already open
    await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 9 }, { email: 'req@x.io' }))
      .rejects.toThrow(/already an open/i);
  });
});

describe('ticketApprovalService.decideInApp', () => {
  test('approve cancels sibling requests and writes a NON-mirrored note', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io', requestGroupId: 'grp-1',
    });

    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'ok', { email: 'alice@x.io', name: 'Alice' });

    // Siblings in the same group cancelled (any-one-approves).
    expect(prismaMock.ticketApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ requestGroupId: 'grp-1', id: { not: 2 } }),
      data: expect.objectContaining({ status: 'cancelled' }),
    }));
    // TP-only: the audit note is never mirrored to FreshService.
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mirrorState: null }),
    }));
    // Workflow event dispatched for the decision.
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith(
      'approval.decided', 501, expect.objectContaining({ extra: expect.any(Object) }),
    );
  });

  test('non-approver without admin cannot decide', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io' });
    await expect(ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'mallory@x.io' }))
      .rejects.toThrow(/only the requested approver/i);
  });
});

describe('ticketApprovalService.requestClarification', () => {
  test('sets info_requested, notifies the requester, and does NOT cancel siblings', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io', requestedBy: 'req@x.io', requestGroupId: 'grp-1',
    });

    const updated = await ticketApprovalService.requestClarification(501, 1, 2, 'Which model?', { email: 'alice@x.io', name: 'Alice' });

    expect(updated.status).toBe('info_requested');
    expect(prismaMock.ticketApproval.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'info_requested', decisionNote: 'Which model?' }),
    }));
    // Siblings must remain (clarification is non-terminal).
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
    // Requester is emailed.
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['req@x.io'] }));
  });

  test('requires a note', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io', requestedBy: 'req@x.io' });
    await expect(ticketApprovalService.requestClarification(501, 1, 2, '  ', { email: 'alice@x.io' }))
      .rejects.toThrow(/clarification is needed/i);
  });
});

describe('ticketApprovalService.resubmit', () => {
  test('requester flips info_requested back to pending with a fresh link', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'info_requested', approverEmail: 'alice@x.io', requestedBy: 'req@x.io', approvalCategoryId: 9,
    });
    prismaMock.approvalCategory.findUnique.mockResolvedValue({ name: 'Laptop purchase' });

    const updated = await ticketApprovalService.resubmit(501, 1, 2, { email: 'req@x.io' });

    expect(updated.status).toBe('pending');
    expect(prismaMock.ticketApproval.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending', decisionNote: null }),
    }));
    // Approver re-notified.
    expect(sendgridMock.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['alice@x.io'] }));
  });

  test('a non-requester cannot resubmit', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 2, ticketId: 501, workspaceId: 1, status: 'info_requested', requestedBy: 'req@x.io' });
    await expect(ticketApprovalService.resubmit(501, 1, 2, { email: 'someone@x.io' }))
      .rejects.toThrow(/only the requester/i);
  });
});
