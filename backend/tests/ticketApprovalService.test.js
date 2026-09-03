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
  technician: { findFirst: jest.fn() },
  requester: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const sendgridMock = { sendEmail: jest.fn().mockResolvedValue({ status: 'ok' }) };
const graphMock = { isConfigured: () => false };
const lifecycleMock = { emitTicketEvent: jest.fn() };
const publicStatusMock = {
  getPublicTicketStatusSettings: jest.fn(),
  ensurePublicTicketStatusLink: jest.fn(),
};
const azureAdMock = { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock, sendEmail: sendgridMock.sendEmail }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => publicStatusMock);
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdMock }));

const {
  default: ticketApprovalService, sanitizeNoteHtml, sanitizeDescriptionHtml, prettifyLocalPart,
} = await import('../src/services/ticketApprovalService.js');

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
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  publicStatusMock.getPublicTicketStatusSettings.mockResolvedValue({ enabled: false, showRequesterEmail: false, showRequesterName: false });
  publicStatusMock.ensurePublicTicketStatusLink.mockResolvedValue({ url: null });
  azureAdMock.isConfigured.mockReturnValue(false);
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

// QA 08-11 #5 + QA 08-17 #2: the requesting agent ALWAYS hears about the
// verdict by email, with the same guard rails as the clarification email
// (kill-switch, email-shape check). Self-decisions send too — with "your own
// approval request" wording — and the self test keys on the DECIDING actor,
// so admin-on-behalf decisions are never silenced.
describe('decision email to the requester (QA 08-11 #5 / 08-17 #2)', () => {
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

  test('self-decision still emails the requester — ONE send, "your own" wording (QA 08-17 #2)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ requestedBy: 'alice@x.io' }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'alice@x.io', name: 'Alice' });

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['alice@x.io']);
    // Subject prefix unchanged (filters/threads keep working); body says self.
    expect(email.subject).toMatch(/^Approved:/);
    expect(email.html).toContain('You approved your own approval request');
  });

  test('self-REJECTION wording follows the verdict', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ requestedBy: 'alice@x.io' }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'changed my mind', { email: 'alice@x.io', name: 'Alice' });

    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.subject).toMatch(/^Rejected:/);
    expect(email.html).toContain('You rejected your own approval request');
    expect(email.html).toContain('Your note');
  });

  test('admin deciding ON BEHALF where requester === approver is NOT a self-decision', async () => {
    // Old bug: the compare used approval.approverEmail, so an admin deciding a
    // request Alice made to herself silenced the email entirely.
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ requestedBy: 'alice@x.io' }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'boss@x.io', name: 'Boss', role: 'admin' });

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['alice@x.io']);
    expect(email.html).toContain('Boss decided your approval request');
    expect(email.html).not.toContain('your own');
  });

  test('decideByToken (magic link) emails the requester too', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(approvalRow());
    await ticketApprovalService.decideByToken('a'.repeat(32), 'approved', 'looks fine');

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['req@x.io']);
    expect(email.subject).toMatch(/^Approved:/);
    expect(email.html).toContain('looks fine');
  });

  test('decideByToken on your own request sends the self variant (link decider = approver)', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(approvalRow({ requestedBy: 'alice@x.io' }));
    await ticketApprovalService.decideByToken('a'.repeat(32), 'approved');

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    expect(sendgridMock.sendEmail.mock.calls[0][0].html).toContain('your own approval request');
  });

  test('changeDecision emails the requester with the changed-decision wording', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(approvalRow({ status: 'approved' }));
    await ticketApprovalService.changeDecision(501, 1, 2, 'rejected', 'reconsidered', { email: 'alice@x.io', name: 'Alice' });

    expect(sendgridMock.sendEmail).toHaveBeenCalledTimes(1);
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.to).toEqual(['req@x.io']);
    expect(email.subject).toMatch(/^Rejected:/);
    expect(email.html).toContain('changed the decision on your approval request');
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

// ---------------------------------------------------------------------------
// Phase AP (09-02): public approval page redesign — payload, gating, sanitizer.
// ---------------------------------------------------------------------------

describe('sanitizeNoteHtml / sanitizeDescriptionHtml (Phase AP class allow-list)', () => {
  test('a pasted-Excel fragment keeps class="tp-data-table" and its borders, other classes drop', () => {
    const excel = '<table class="tp-data-table" style="border-collapse:collapse;width:420px" width="420">'
      + '<thead class="tp-data-table"><tr class="xl-row"><th class="xl65" style="border:1px solid #000">Vendor</th></tr></thead>'
      + '<tbody><tr><td class="xl66 tp-data-table" style="border:1px solid #cbd5e1;text-align:right">1,250</td></tr></tbody></table>';
    const out = sanitizeNoteHtml(excel);
    expect(out).toContain('<table class="tp-data-table"');
    expect(out).toContain('style="border-collapse:collapse;width:420px"');
    expect(out).toContain('width="420"');
    expect(out).toContain('<thead class="tp-data-table">');
    expect(out).toContain('<th style="border:1px solid #000">');
    expect(out).toContain('<td class="tp-data-table" style="border:1px solid #cbd5e1;text-align:right">');
    expect(out).not.toMatch(/xl6\d|xl-row/);
  });

  test('class is only honoured on the table set', () => {
    const out = sanitizeNoteHtml('<p class="tp-data-table">x</p><div class="tp-data-table">y</div>');
    expect(out).toBe('<p>x</p><div>y</div>');
  });

  test('description sanitizer keeps https images, drops cid:/data: images and scripts', () => {
    const html = '<h2>Quote</h2><p>See <img src="cid:image001.png@01DA"> and <img src="https://cdn.example.com/q.png" alt="q"></p>'
      + '<img src="data:image/png;base64,iVBORw0KGgo="><script>alert(1)</script><pre>code</pre>';
    const out = sanitizeDescriptionHtml(html);
    expect(out).toContain('<h2>Quote</h2>');
    expect(out).toContain('<img src="https://cdn.example.com/q.png" alt="q" />');
    expect(out).not.toContain('cid:');
    expect(out).not.toContain('data:image');
    expect(out).not.toContain('<script');
    expect(out).toContain('<pre>code</pre>');
    // The stripped images leave no empty <img> husk behind.
    expect((out.match(/<img/g) || []).length).toBe(1);
  });

  test('prettifyLocalPart turns an address into a readable name', () => {
    expect(prettifyLocalPart('jane.doe@x.io')).toBe('Jane Doe');
    expect(prettifyLocalPart('susan_manager@x.io')).toBe('Susan Manager');
    expect(prettifyLocalPart('')).toBeNull();
  });
});

describe('ticketApprovalService.getByToken (Phase AP payload)', () => {
  const TOKEN = 'b'.repeat(43);
  const future = new Date(Date.now() + 86400000);
  const fullTicket = {
    id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 77, freshserviceTicketId: null,
    subject: 'New laptop', status: 'open', priority: 3, ticketType: 'Service Request',
    category: 'Legacy cat', subCategory: 'Legacy sub', createdAt: new Date('2026-09-01T10:00:00Z'), dueBy: null,
    description: '<p>Need a <b>laptop</b></p><img src="cid:img1"><img src="https://cdn.example.com/spec.png">',
    descriptionText: 'Need a laptop',
    internalCategory: { name: 'Hardware' }, internalSubcategory: { name: 'Laptop' },
    requester: {
      name: 'Rita Requester', email: 'rita@x.io', jobTitle: 'Analyst', entraJobTitle: null,
      department: 'Finance', entraDepartment: null, entraOfficeLocation: 'Vancouver', entraCity: null,
    },
    workspace: { name: 'IT', slug: 'it' },
  };
  const row = (over = {}) => ({
    id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'bob@x.io', approverName: null,
    requestedBy: 'jane.doe@x.io', requestGroupId: 'grp-1', approvalCategoryId: 9,
    requestNote: 'pls', requestNoteHtml: null, decisionNote: null, decisionNoteHtml: null,
    clarificationLog: null, decidedAt: null, decidedVia: null, expiresAt: future,
    createdAt: new Date('2026-09-01T09:00:00Z'), updatedAt: new Date('2026-09-01T09:00:00Z'), ...over,
  });

  beforeEach(() => {
    prismaMock.ticket.findUnique.mockResolvedValue(fullTicket);
    prismaMock.approvalCategory.findUnique.mockResolvedValue({ name: 'Laptop purchase', description: 'Hardware over $1k' });
  });

  test('shapes the contract: resolved names, category path, priority label, sanitized description, no sibling emails', async () => {
    const decidedAt = new Date('2026-09-01T12:00:00Z');
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({
      status: 'cancelled', decisionNote: 'Superseded — approved by Alice Manager', decidedAt,
    }));
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { id: 1, status: 'approved', approverEmail: 'alice@x.io', approverName: 'Alice Manager', decidedAt, decisionNote: 'ok' },
      { id: 2, status: 'cancelled', approverEmail: 'bob@x.io', approverName: null, decidedAt, decisionNote: 'Superseded — approved by Alice Manager' },
    ]);

    const data = await ticketApprovalService.getByToken(TOKEN);

    expect(data.approval).toMatchObject({
      id: 2, status: 'cancelled', approverEmail: 'bob@x.io', approverName: null,
      requestedByEmail: 'jane.doe@x.io', requestedByName: 'Jane Doe', requestedByPhotoUrl: null,
      category: { name: 'Laptop purchase', description: 'Hardware over $1k' },
      supersededBy: { name: 'Alice Manager', decision: 'approved', decidedAt },
      cancelledReason: null, clarificationLog: [],
    });
    expect(data.ticket).toMatchObject({
      id: 501, displayRef: 'TP-77', subject: 'New laptop', priority: 3, priorityLabel: 'High',
      ticketType: 'Service Request', categoryPath: 'Hardware › Laptop', descriptionText: 'Need a laptop',
      workspace: { name: 'IT', slug: 'it' },
    });
    expect(data.ticket.appTicketUrl).toMatch(/^https?:\/\/.+\/tickets\/501$/);
    expect(data.ticket.descriptionHtml).toContain('<img src="https://cdn.example.com/spec.png" />');
    expect(data.ticket.descriptionHtml).not.toContain('cid:');
    // Requester: name/title/department/location always; email gated (default off); never phone.
    expect(data.ticket.requester).toEqual({
      name: 'Rita Requester', email: null, title: 'Analyst', department: 'Finance', location: 'Vancouver', photoUrl: null,
    });
    // Approvers: names + status + isYou, and NEVER an address or token.
    expect(data.approvers).toEqual([
      { name: 'Alice Manager', status: 'approved', isYou: false, decidedAt },
      { name: 'Bob', status: 'cancelled', isYou: true, decidedAt },
    ]);
    expect(JSON.stringify(data.approvers)).not.toContain('@');
    expect(JSON.stringify(data)).not.toContain(TOKEN);
    expect(typeof data.meta.viewedAt).toBe('string');
    // View telemetry bumped (non-fatal).
    expect(prismaMock.ticketApproval.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 2 }, data: expect.objectContaining({ viewCount: { increment: 1 } }),
    }));
  });

  test('supersededBy falls back to the decided sibling when the note lacks the convention', async () => {
    const decidedAt = new Date('2026-09-01T12:00:00Z');
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ status: 'cancelled', decisionNote: null, decidedAt }));
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { id: 1, status: 'rejected', approverEmail: 'alice@x.io', approverName: null, decidedAt, decisionNote: 'no' },
      { id: 2, status: 'cancelled', approverEmail: 'bob@x.io', approverName: null, decidedAt, decisionNote: null },
    ]);
    prismaMock.technician.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.email.equals === 'alice@x.io' ? { name: 'Alice From Directory' } : null,
    ));
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.approval.supersededBy).toEqual({ name: 'Alice From Directory', decision: 'rejected', decidedAt });
    expect(data.approvers[0].name).toBe('Alice From Directory');
  });

  test('a requester-cancelled row carries cancelledReason, not supersededBy', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ status: 'cancelled', decisionNote: 'Cancelled by jane.doe@x.io', requestGroupId: null }));
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.approval.supersededBy).toBeNull();
    expect(data.approval.cancelledReason).toBe('Cancelled by jane.doe@x.io');
    expect(data.approvers).toEqual([{ name: 'Bob', status: 'cancelled', isYou: true, decidedAt: null }]);
  });

  test('clarificationLog maps the JSONB Q&A and surfaces the open question while info_requested', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({
      status: 'info_requested', decisionNote: 'Which model?',
      clarificationLog: [
        { question: 'Budget code?', askedBy: 'bob@x.io', askedAt: '2026-08-30T10:00:00.000Z', answer: 'IT-204', answeredBy: 'jane.doe@x.io', answeredAt: '2026-08-30T11:00:00.000Z' },
        { question: 'Which model?', askedBy: 'bob@x.io', askedAt: '2026-09-01T10:00:00.000Z' },
      ],
    }));
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.approval.clarificationLog).toEqual([
      { question: 'Budget code?', askedBy: 'bob@x.io', askedByName: 'Bob', askedAt: '2026-08-30T10:00:00.000Z', answer: 'IT-204', answeredBy: 'jane.doe@x.io', answeredByName: 'Jane Doe', answeredAt: '2026-08-30T11:00:00.000Z' },
      { question: 'Which model?', askedBy: 'bob@x.io', askedByName: 'Bob', askedAt: '2026-09-01T10:00:00.000Z', answer: null, answeredBy: null, answeredByName: null, answeredAt: null },
    ]);
    expect(data.approval.decisionNote).toBe('Which model?');
  });

  test('legacy info_requested row without a log reconstructs the open question from decisionNote', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ status: 'info_requested', decisionNote: 'Which model?', clarificationLog: null }));
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.approval.clarificationLog).toHaveLength(1);
    expect(data.approval.clarificationLog[0]).toMatchObject({ question: 'Which model?', askedBy: 'bob@x.io', answer: null });
  });

  test('requester email opens up when the workspace settings allow — and no public status token is ever minted', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    publicStatusMock.getPublicTicketStatusSettings.mockResolvedValue({ enabled: true, showRequesterEmail: true, showRequesterName: true });
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.ticket.requester.email).toBe('rita@x.io');
    // The page links to the ticket itself now; nothing public is created.
    expect(data.ticket.publicStatusUrl).toBeUndefined();
    expect(data.ticket.appTicketUrl).toMatch(/\/tickets\/501$/);
    expect(publicStatusMock.ensurePublicTicketStatusLink).not.toHaveBeenCalled();
  });

  test('public status link is never minted when the surface is disabled', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    await ticketApprovalService.getByToken(TOKEN);
    expect(publicStatusMock.ensurePublicTicketStatusLink).not.toHaveBeenCalled();
  });

  test('photo URLs appear only when Entra is configured, and point at the token photo route', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    azureAdMock.isConfigured.mockReturnValue(true);
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.approval.requestedByPhotoUrl).toBe(`/api/ticket-approvals/public/${TOKEN}/photo?who=requestedBy`);
    expect(data.ticket.requester.photoUrl).toBe(`/api/ticket-approvals/public/${TOKEN}/photo?who=requester`);
  });

  test('categoryPath falls back to the legacy category strings', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    prismaMock.ticket.findUnique.mockResolvedValue({ ...fullTicket, internalCategory: null, internalSubcategory: null });
    const data = await ticketApprovalService.getByToken(TOKEN);
    expect(data.ticket.categoryPath).toBe('Legacy cat › Legacy sub');
  });

  test('photoSubjectEmail resolves from the row — never from a caller-supplied address', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    await expect(ticketApprovalService.photoSubjectEmail(TOKEN, 'requestedBy')).resolves.toBe('jane.doe@x.io');
    await expect(ticketApprovalService.photoSubjectEmail(TOKEN, 'requester')).resolves.toBe('rita@x.io');
    await expect(ticketApprovalService.photoSubjectEmail(TOKEN, 'attacker@x.io')).rejects.toThrow(/who must be/);
  });
});

describe('decideByToken (Phase AP: reject needs a reason, decisions show a person)', () => {
  const TOKEN = 'c'.repeat(43);
  const row = (over = {}) => ({
    id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approverEmail: 'bob@x.io', approverName: null,
    requestedBy: 'req@x.io', requestGroupId: 'grp-1', expiresAt: new Date(Date.now() + 86400000), ...over,
  });

  test('rejecting without a note is refused (400) and nothing is written', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    await expect(ticketApprovalService.decideByToken(TOKEN, 'rejected', '   ')).rejects.toThrow(/Add a reason for rejecting/);
    expect(prismaMock.ticketApproval.update).not.toHaveBeenCalled();
  });

  test('rejecting with a note goes through and returns the decided row', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    const out = await ticketApprovalService.decideByToken(TOKEN, 'rejected', 'No budget this quarter');
    expect(out.status).toBe('rejected');
    expect(out.decisionNote).toBe('No budget this quarter');
  });

  test('approving still needs no note', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    const out = await ticketApprovalService.decideByToken(TOKEN, 'approved');
    expect(out.status).toBe('approved');
  });

  test('a link approver with no name is resolved from the directory so the decision shows a person', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    prismaMock.technician.findFirst.mockResolvedValue({ name: 'Bob Builder' });
    const out = await ticketApprovalService.decideByToken(TOKEN, 'approved');
    expect(out.approverName).toBe('Bob Builder');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ actorName: 'Bob Builder', bodyText: expect.stringContaining('by Bob Builder') }),
    }));
    expect(prismaMock.ticketApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ decisionNote: 'Superseded — approved by Bob Builder' }),
    }));
  });

  test('falls back to the Requester directory, then the raw address', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    prismaMock.requester.findFirst.mockResolvedValue({ name: 'Bob (Requester)' });
    const out = await ticketApprovalService.decideByToken(TOKEN, 'approved');
    expect(out.approverName).toBe('Bob (Requester)');

    jest.clearAllMocks();
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    prismaMock.ticketApproval.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    prismaMock.technician.findFirst.mockRejectedValue(new Error('db down'));
    const out2 = await ticketApprovalService.decideByToken(TOKEN, 'approved');
    expect(out2.approverName).toBe('bob@x.io');
  });
});

describe('_emailApprover (Phase AP: people, category, requester title)', () => {
  test('says "Note from <name>", adds the category line and the requester title', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ ...ticket, requester: { name: 'Rita', email: 'rita@x.io', jobTitle: 'Analyst' } });
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);

    await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'Need {{decision.url}} please' }, { email: 'jane.doe@x.io' });

    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.html).toContain('Note from Jane Doe');
    expect(email.html).not.toContain('Note from jane.doe@x.io');
    expect(email.subject).toBe('Approval needed: Laptop purchase for Rita — New laptop [TP-ID-501]');
    expect(email.html).toContain('Laptop purchase approval');
    expect(email.html).toContain('Requested for');
    expect(email.html).toContain('>Rita<');
    expect(email.html).toContain('Analyst');
    expect(email.html).toContain('Review and decide');
    // Placeholders still substitute.
    expect(email.html).toContain('review &amp; decide</a>');
  });

  test('embeds people photos as inline (cid:) attachments — never a URL', async () => {
    const { resetUserPhotoCache } = await import('../src/services/userPhotoService.js');
    resetUserPhotoCache();
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    azureAdMock.getUserPhoto.mockImplementation(async (email) => (email === 'rita.photo@x.io' ? `data:image/png;base64,${PNG}` : null));
    prismaMock.ticket.findFirst.mockResolvedValue({ ...ticket, requester: { name: 'Rita', email: 'rita.photo@x.io', jobTitle: 'Analyst' } });
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);

    await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'pls' }, { email: 'nophoto.agent@x.io' });

    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.attachments).toEqual([
      { name: 'requester-photo.png', contentType: 'image/png', contentBytes: PNG, contentId: 'requester-photo', inline: true },
    ]);
    expect(email.html).toContain('<img src="cid:requester-photo"');
    // The agent has no directory photo → initials, no dangling cid reference.
    expect(email.html).not.toContain('cid:requested-by-photo');
    expect(email.html).not.toMatch(/<img[^>]+src="https?:/);
    azureAdMock.getUserPhoto.mockReset();
  });

  test('uses the directory name when the requester is a known technician', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 9, name: 'Laptop purchase', managerEmails: ['alice@x.io'] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);
    prismaMock.technician.findFirst.mockResolvedValue({ name: 'Jane Doe-Smith' });
    await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'pls' }, { email: 'jdoe@x.io' });
    expect(sendgridMock.sendEmail.mock.calls[0][0].html).toContain('Note from Jane Doe-Smith');
  });
});
