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

  test('request description keeps pasted tables but strips scripts (Phase C widened allowlist)', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);

    const noteHtml = '<p>Quotes:</p><table><tbody><tr>'
      + '<td colspan="2" style="border:1px solid #ccc">Vendor</td><td>Price</td></tr></tbody></table>'
      + '<script>alert(1)</script>';
    await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'Quotes', noteHtml }, { email: 'req@x.io' });

    const stored = prismaMock.ticketApproval.create.mock.calls[0][0].data.requestNoteHtml;
    expect(stored).toContain('<table');
    expect(stored).toContain('colspan="2"');
    expect(stored).toContain('border:1px solid #ccc');
    expect(stored).not.toContain('<script');
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

  test('a reply answers the clarification, writes a thread note, and travels in the email (QA 07-14 #1)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'info_requested', approverEmail: 'alice@x.io', requestedBy: 'req@x.io',
      approvalCategoryId: 9, decisionNote: 'Which budget code?',
      clarificationLog: [{ question: 'Which budget code?', askedBy: 'alice@x.io', askedAt: '2026-07-14T00:00:00.000Z' }],
    });
    prismaMock.approvalCategory.findUnique.mockResolvedValue({ name: 'Laptop purchase' });

    await ticketApprovalService.resubmit(501, 1, 2, { email: 'req@x.io' }, { note: 'IT-204' });

    const { data } = prismaMock.ticketApproval.update.mock.calls[0][0];
    expect(data.clarificationLog).toHaveLength(1);
    expect(data.clarificationLog[0]).toMatchObject({ question: 'Which budget code?', answer: 'IT-204', answeredBy: 'req@x.io' });
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bodyText: expect.stringContaining('IT-204'), isPrivate: true }),
    }));
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.html).toContain('IT-204');
    expect(email.html).toContain('Which budget code?');
  });
});

// Custom Fields Activation Phase 1 rider: approval notes carry a structured
// rawPayload discriminator so the frontend dispatches approval event cards
// without regexing bodies (the regex stays as legacy fallback — bodies are
// unchanged, asserted here too).
describe('approval note rawPayload kinds (structured discriminator)', () => {
  const noteRawPayload = () => prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload;
  const noteBody = () => prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyText;

  test('approve note → event: approved', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io',
    });
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'ok', { email: 'alice@x.io', name: 'Alice' });
    expect(noteRawPayload()).toEqual({ kind: 'approval_event', v: 1, event: 'approved' });
    expect(noteBody()).toContain('APPROVED'); // body unchanged for the regex fallback
  });

  test('reject note → event: rejected', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io',
    });
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'no', { email: 'alice@x.io', name: 'Alice' });
    expect(noteRawPayload()).toEqual({ kind: 'approval_event', v: 1, event: 'rejected' });
    expect(noteBody()).toContain('REJECTED');
  });

  test('changed decision note → event: changed', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'approved', approverEmail: 'alice@x.io',
    });
    await ticketApprovalService.changeDecision(501, 1, 2, 'rejected', 'reconsidered', { email: 'alice@x.io', name: 'Alice' });
    expect(noteRawPayload()).toEqual({ kind: 'approval_event', v: 1, event: 'changed' });
    expect(noteBody()).toContain('CHANGED');
  });

  test('clarification request note → event: clarification', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'alice@x.io', requestedBy: 'req@x.io',
    });
    await ticketApprovalService.requestClarification(501, 1, 2, 'Which model?', { email: 'alice@x.io', name: 'Alice' });
    expect(noteRawPayload()).toEqual({ kind: 'approval_event', v: 1, event: 'clarification' });
  });

  test('resubmit reply note → event: requested (back in front of the approver)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({
      id: 2, ticketId: 501, workspaceId: 1, status: 'info_requested', approverEmail: 'alice@x.io', requestedBy: 'req@x.io',
      approvalCategoryId: 9, decisionNote: 'Which budget code?',
      clarificationLog: [{ question: 'Which budget code?', askedBy: 'alice@x.io', askedAt: '2026-07-14T00:00:00.000Z' }],
    });
    prismaMock.approvalCategory.findUnique.mockResolvedValue({ name: 'Laptop purchase' });
    await ticketApprovalService.resubmit(501, 1, 2, { email: 'req@x.io' }, { note: 'IT-204' });
    expect(noteRawPayload()).toEqual({ kind: 'approval_event', v: 1, event: 'requested' });
  });
});

// QA 08-11 #5: the requesting agent hears about the verdict by email, with the
// same guard rails as the clarification email (kill-switch, email-shape check)
// plus a don't-email-yourself skip when the requester decided their own request.
describe('decision email to the requester (QA 08-11 #5)', () => {
  const approvalRow = (over = {}) => ({
    id: 2, ticketId: 501, workspaceId: 1, status: 'pending',
    approverEmail: 'alice@x.io', requestedBy: 'req@x.io', requestGroupId: 'grp-1', ...over,
  });

  test('approve emails the requester: verdict + note + ticket link', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow());
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'go ahead', { email: 'alice@x.io', name: 'Alice' });

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['req@x.io']);
    expect(email.subject).toMatch(/^Approved:/);
    expect(email.html).toContain('APPROVED');
    expect(email.html).toContain('go ahead');
    expect(email.html).toContain('/tickets/501');
  });

  test('reject emails the requester with the rejection', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow());
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'no budget', { email: 'alice@x.io', name: 'Alice' });

    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['req@x.io']);
    expect(email.subject).toMatch(/^Rejected:/);
    expect(email.html).toContain('REJECTED');
    expect(email.html).toContain('no budget');
  });

  test('TP_SUPPRESS_APPROVAL_EMAIL kill-switch suppresses the decision email', async () => {
    process.env.TP_SUPPRESS_APPROVAL_EMAIL = '1';
    try {
      prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow());
      await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'alice@x.io', name: 'Alice' });
      expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
    } finally {
      delete process.env.TP_SUPPRESS_APPROVAL_EMAIL;
    }
  });

  test('requester === approver skips (no email to yourself)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ requestedBy: 'alice@x.io' }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'alice@x.io', name: 'Alice' });
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('non-email requestedBy (legacy "unknown") skips the email', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ requestedBy: 'unknown' }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'alice@x.io', name: 'Alice' });
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });

  test('approval.decided event extra carries requestedBy (workflow targeting)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow());
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'alice@x.io', name: 'Alice' });
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith(
      'approval.decided', 501,
      expect.objectContaining({ extra: expect.objectContaining({ requestedBy: 'req@x.io', status: 'approved' }) }),
    );
  });
});

describe('ticketApprovalService.request notifyApprover toggle (QA 07-14 #2)', () => {
  test('notifyApprover: false suppresses the approver email but still creates the request', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);

    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, notifyApprover: false }, { email: 'req@x.io' });

    expect(res.count).toBe(1);
    expect(sendgridMock.sendEmail).not.toHaveBeenCalled();
  });
});
