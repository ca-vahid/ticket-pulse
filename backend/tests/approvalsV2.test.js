import { jest } from '@jest/globals';

/**
 * Approvals v2 (QA 09-15 #8, v3.8.91): tiered categories, amounts with
 * auto-escalation, escalate / forward hand-offs, and the token page contract.
 */

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  approvalCategory: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticketApproval: {
    findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(),
  },
  ticketThreadEntry: { create: jest.fn() },
  ticketAttachment: { findMany: jest.fn() },
  mailboxConnection: { findFirst: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  workspaceAccess: { findMany: jest.fn() },
  requester: { findFirst: jest.fn() },
};
const activityMock = { create: jest.fn() };
const sendgridMock = { sendEmail: jest.fn().mockResolvedValue({ status: 'ok' }) };
const lifecycleMock = { emitTicketEvent: jest.fn() };
const publicStatusMock = { getPublicTicketStatusSettings: jest.fn(), ensurePublicTicketStatusLink: jest.fn() };
const azureAdMock = { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock, sendEmail: sendgridMock.sendEmail }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => publicStatusMock);
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdMock }));

const { default: ticketApprovalService, formatAmount } = await import('../src/services/ticketApprovalService.js');
const { default: approvalCategoryService } = await import('../src/services/approvalCategoryService.js');
const { categoryTiers } = await import('../src/utils/approvalTiers.js');
const { clampFastSyncInterval, fastSyncCronExpression } = await import('../src/utils/fastSyncCron.js');
const { renderApproverRequestEmail, renderRequesterHandoffEmail } = await import('../src/services/approvalEmailTemplate.js');

const ticket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1234, subject: 'New laptop', status: 'Open', priority: 2,
  requester: { name: 'Rita', email: 'rita@x.io' }, workspace: { name: 'IT', slug: 'it' },
};

const SECURITY = {
  id: 9, workspaceId: 1, name: 'Security', isActive: true, hasAmount: true, amountCurrency: 'CAD',
  managerEmails: ['vahid@x.io'],
  tiers: [
    { name: 'Tier 1', managerEmails: ['vahid@x.io'], limit: 5000 },
    { name: 'Tier 2', managerEmails: ['neville@x.io'], limit: null },
  ],
};

const row = (over = {}) => ({
  id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approvalCategoryId: 9, tier: 1, isFinal: false,
  approverEmail: 'vahid@x.io', approverName: 'Vahid', requestedBy: 'req@x.io', requestGroupId: 'grp-1',
  requestNote: 'Need a firewall', requestNoteHtml: null, amount: '6000', amountCurrency: 'CAD', escalationLog: null,
  expiresAt: new Date(Date.now() + 86400000), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  activityMock.create.mockResolvedValue({});
  sendgridMock.sendEmail.mockResolvedValue({ status: 'ok' });
  prismaMock.ticket.findFirst.mockResolvedValue(ticket);
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.approvalCategory.findFirst.mockResolvedValue(SECURITY);
  prismaMock.approvalCategory.findUnique.mockResolvedValue(SECURITY);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticketApproval.findMany.mockResolvedValue([]);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  publicStatusMock.getPublicTicketStatusSettings.mockResolvedValue({ enabled: false, showRequesterEmail: false });
  let seq = 100;
  prismaMock.ticketApproval.create.mockImplementation(({ data }) => Promise.resolve({ id: ++seq, ...data }));
  prismaMock.ticketApproval.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
});

describe('request() on a monetary category', () => {
  test('needs an amount and stores it on every tier-1 row', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);
    await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 9 }, { email: 'req@x.io' }))
      .rejects.toThrow(/need an amount/);
    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, amount: '6,000'.replace(',', '') }, { email: 'req@x.io' });
    expect(res.count).toBe(1);
    expect(prismaMock.ticketApproval.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tier: 1, amount: 6000, amountCurrency: 'CAD', approverEmail: 'vahid@x.io' }),
    }));
    // Amount travels in the approver e-mail.
    const email = sendgridMock.sendEmail.mock.calls[0][0];
    expect(email.html).toContain('6,000.00');
  });

  test('a pre-v2 category (no tiers, not monetary) behaves as before', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ id: 3, name: 'Laptop', isActive: true, managerEmails: ['alice@x.io'], tiers: null, hasAmount: false });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(null);
    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 3 }, { email: 'req@x.io' });
    expect(res.count).toBe(1);
    const data = prismaMock.ticketApproval.create.mock.calls[0][0].data;
    expect(data.tier).toBe(1);
    expect(data.amount).toBeUndefined();
  });
});

describe('escalate()', () => {
  test('closes the row as escalated, supersedes same-tier siblings, creates tier-2 rows and e-mails both sides', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    const out = await ticketApprovalService.escalate(501, 1, 2, { note: 'Needs CISO sign-off' }, { email: 'vahid@x.io', name: 'Vahid' });

    expect(out.status).toBe('escalated');
    expect(out.decisionNote).toMatch(/Escalated to Tier 2/);
    expect(out.escalationLog).toEqual([expect.objectContaining({ kind: 'escalated', fromTier: 1, toTier: 2, toEmails: ['neville@x.io'], note: 'Needs CISO sign-off' })]);
    expect(out.handoff).toEqual(expect.objectContaining({ kind: 'escalated', to: ['neville@x.io'] }));

    expect(prismaMock.ticketApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ requestGroupId: 'grp-1', tier: 1, id: { not: 2 } }),
      data: expect.objectContaining({ status: 'cancelled', decisionNote: 'Superseded — escalated by Vahid' }),
    }));
    expect(prismaMock.ticketApproval.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approverEmail: 'neville@x.io', tier: 2, isFinal: false, requestGroupId: 'grp-1', amount: 6000, requestedBy: 'req@x.io' }),
    }));
    // Approver e-mail carries the note; the requester e-mail does not.
    const subjects = sendgridMock.sendEmail.mock.calls.map((c) => c[0]);
    const toNeville = subjects.find((m) => m.to.includes('neville@x.io'));
    const toRequester = subjects.find((m) => m.to.includes('req@x.io'));
    expect(toNeville.subject).toMatch(/^Approval needed/);
    expect(toNeville.html).toContain('Needs CISO sign-off');
    expect(toNeville.html).toContain('escalated this request');
    expect(toRequester.subject).toMatch(/^Escalated:/);
    expect(toRequester.html).not.toContain('Needs CISO sign-off');
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith('approval.escalated', 501, expect.any(Object));
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mirrorState: null, rawPayload: expect.objectContaining({ event: 'escalated' }) }),
    }));
  });

  test('needs a note, a next tier, and an open row', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await expect(ticketApprovalService.escalate(501, 1, 2, { note: '' }, { email: 'vahid@x.io' })).rejects.toThrow(/Add a note/);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ tier: 2, approverEmail: 'neville@x.io' }));
    await expect(ticketApprovalService.escalate(501, 1, 2, { note: 'x' }, { email: 'neville@x.io' })).rejects.toThrow(/no tier above Tier 2/);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'approved' }));
    await expect(ticketApprovalService.escalate(501, 1, 2, { note: 'x' }, { email: 'vahid@x.io' })).rejects.toThrow(/already approved/);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ isFinal: true }));
    await expect(ticketApprovalService.escalate(501, 1, 2, { note: 'x' }, { email: 'vahid@x.io' })).rejects.toThrow(/final approver/);
  });

  test('only the approver or an admin may escalate', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await expect(ticketApprovalService.escalate(501, 1, 2, { note: 'x' }, { email: 'someone@x.io' })).rejects.toThrow(/Only the requested approver/);
    const out = await ticketApprovalService.escalate(501, 1, 2, { note: 'admin move' }, { email: 'admin@x.io', name: 'Admin', role: 'admin' });
    expect(out.status).toBe('escalated');
  });
});

describe('forward()', () => {
  test('creates one final row for the target and closes the row as forwarded', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ tier: 2, approverEmail: 'neville@x.io', approverName: 'Neville' }));
    const out = await ticketApprovalService.forward(501, 1, 2, { toEmail: 'Bryan@x.io', note: 'Your budget line' }, { email: 'neville@x.io', name: 'Neville' });
    expect(out.status).toBe('forwarded');
    expect(prismaMock.ticketApproval.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approverEmail: 'bryan@x.io', tier: 2, isFinal: true }),
    }));
    expect(prismaMock.ticketApproval.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ decisionNote: 'Superseded — forwarded by Neville' }),
    }));
    const toBryan = sendgridMock.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to.includes('bryan@x.io'));
    expect(toBryan.html).toContain('final approver');
    expect(lifecycleMock.emitTicketEvent).toHaveBeenCalledWith('approval.forwarded', 501, expect.any(Object));
  });

  test('refuses the requester, yourself, and a missing note', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await expect(ticketApprovalService.forward(501, 1, 2, { toEmail: 'req@x.io', note: 'x' }, { email: 'vahid@x.io' })).rejects.toThrow(/requester cannot decide/);
    await expect(ticketApprovalService.forward(501, 1, 2, { toEmail: 'vahid@x.io', note: 'x' }, { email: 'vahid@x.io' })).rejects.toThrow(/already hold/);
    await expect(ticketApprovalService.forward(501, 1, 2, { toEmail: 'bryan@x.io', note: '' }, { email: 'vahid@x.io' })).rejects.toThrow(/Add a note/);
    await expect(ticketApprovalService.forward(501, 1, 2, { toEmail: 'nope', note: 'x' }, { email: 'vahid@x.io' })).rejects.toThrow(/Pick who/);
  });
});

describe('amount-based auto-escalation on approve', () => {
  test('approving above the tier limit moves the request on instead of ending it', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ amount: '6000' }));
    const out = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'fine by me', { email: 'vahid@x.io', name: 'Vahid' });
    expect(out.status).toBe('escalated');
    expect(out.decisionNote).toMatch(/Approved — over the Tier 1 limit \(\$5,000\.00\), sent on to Tier 2 automatically/);
    expect(out.escalationLog[0]).toEqual(expect.objectContaining({ kind: 'auto', decision: 'approved', limit: 5000 }));
    expect(prismaMock.ticketApproval.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approverEmail: 'neville@x.io', tier: 2 }) }));
    const toNeville = sendgridMock.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to.includes('neville@x.io'));
    expect(toNeville.html).toContain('your approval is needed');
    // No decision e-mail to the requester — a hand-off e-mail instead.
    const toRequester = sendgridMock.sendEmail.mock.calls.map((c) => c[0]).find((m) => m.to.includes('req@x.io'));
    expect(toRequester.subject).toMatch(/^Escalated:/);
    expect(toRequester.html).toContain('moved on to');
  });

  test('approving within the limit ends the request as usual', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ amount: '4000' }));
    const out = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'vahid@x.io', name: 'Vahid' });
    expect(out.status).toBe('approved');
    expect(prismaMock.ticketApproval.create).not.toHaveBeenCalled();
  });

  test('rejecting above the limit ends the request (no escalation)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ amount: '6000' }));
    const out = await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'no', { email: 'vahid@x.io', name: 'Vahid' });
    expect(out.status).toBe('rejected');
    expect(prismaMock.ticketApproval.create).not.toHaveBeenCalled();
  });

  test('a forwarded (final) row approves outright even above the limit; so does the last tier', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ amount: '9000', isFinal: true, approverEmail: 'bryan@x.io' }));
    let out = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'bryan@x.io', name: 'Bryan' });
    expect(out.status).toBe('approved');
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ amount: '9000', tier: 2, approverEmail: 'neville@x.io' }));
    out = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'neville@x.io', name: 'Neville' });
    expect(out.status).toBe('approved');
    expect(prismaMock.ticketApproval.create).not.toHaveBeenCalled();
  });

  test('magic-link approve auto-escalates the same way', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ amount: '7500' }));
    const out = await ticketApprovalService.decideByToken('c'.repeat(43), 'approved', null);
    expect(out.status).toBe('escalated');
    expect(out.handoff.kind).toBe('auto');
  });
});

describe('token page contract (getByToken) and handoffByToken', () => {
  test('exposes tier position, limit, auto-escalation and forward candidates', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row({ amount: '6000' }));
    prismaMock.ticketApproval.findMany.mockResolvedValue([
      { id: 2, status: 'pending', approverEmail: 'vahid@x.io', approverName: 'Vahid', decidedAt: null, decisionNote: null, tier: 1 },
    ]);
    prismaMock.workspaceAccess.findMany.mockResolvedValue([{ email: 'bryan@x.io', name: 'Bryan' }, { email: 'req@x.io', name: 'Req' }, { email: 'vahid@x.io', name: 'Vahid' }]);
    prismaMock.technician.findMany.mockResolvedValue([{ email: 'tech@x.io', name: 'Tech' }]);
    prismaMock.ticket.findUnique.mockResolvedValue({ ...ticket, requester: { name: 'Rita', email: 'rita@x.io' } });
    const out = await ticketApprovalService.getByToken('c'.repeat(43));
    expect(out.approval).toEqual(expect.objectContaining({
      tier: 1, tierName: 'Tier 1', tierCount: 2, canEscalate: true, isFinal: false,
      amount: 6000, amountLabel: '$6,000.00', amountLimit: 5000, amountLimitLabel: '$5,000.00', autoEscalates: true,
      nextTier: { name: 'Tier 2', approverNames: ['Neville'] },
    }));
    expect(out.approvers[0]).toEqual(expect.objectContaining({ tier: 1, tierName: 'Tier 1', isYou: true }));
    // Requester and the viewer are never forward targets.
    expect(out.forwardCandidates.map((c) => c.email)).toEqual(['bryan@x.io', 'tech@x.io']);
  });

  test('handoffByToken escalates with the note, and refuses forward without a target', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    const out = await ticketApprovalService.handoffByToken('c'.repeat(43), { mode: 'escalate', note: 'CISO' });
    expect(out.status).toBe('escalated');
    await expect(ticketApprovalService.handoffByToken('c'.repeat(43), { mode: 'forward', note: 'x' })).rejects.toThrow(/Pick who/);
  });
});

describe('approvalCategoryService tiers + amounts', () => {
  test('create validates tiers: managers per tier, ascending limits, max 3, tier 1 mirrors managerEmails', async () => {
    prismaMock.approvalCategory.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
    await expect(approvalCategoryService.create(1, { name: 'Sec', hasAmount: true, tiers: [{ managerEmails: [] }] })).rejects.toThrow(/at least one approver/);
    await expect(approvalCategoryService.create(1, {
      name: 'Sec', hasAmount: true,
      tiers: [{ managerEmails: ['a@x.io'], limit: 5000 }, { managerEmails: ['b@x.io'], limit: 4000 }, { managerEmails: ['c@x.io'] }],
    })).rejects.toThrow(/must be higher/);
    await expect(approvalCategoryService.create(1, {
      name: 'Sec', tiers: [1, 2, 3, 4].map((i) => ({ managerEmails: [`p${i}@x.io`] })),
    })).rejects.toThrow(/At most 3/);
    const created = await approvalCategoryService.create(1, {
      name: 'Security', hasAmount: true, amountCurrency: 'cad',
      tiers: [{ name: '', managerEmails: ['Vahid@x.io'], limit: '5000' }, { name: 'CISO', managerEmails: ['neville@x.io'], limit: 99999 }],
    });
    expect(created.managerEmails).toEqual(['vahid@x.io']);
    expect(created.amountCurrency).toBe('CAD');
    // The last tier never keeps a limit; a blank name gets a default.
    expect(created.tiers).toEqual([{ name: 'Tier 1', managerEmails: ['vahid@x.io'], limit: 5000 }, { name: 'CISO', managerEmails: ['neville@x.io'], limit: null }]);
  });

  test('a legacy managerEmails-only patch keeps tier 1 in step', async () => {
    prismaMock.approvalCategory.findFirst.mockResolvedValue(SECURITY);
    prismaMock.approvalCategory.update.mockImplementation(({ data }) => Promise.resolve({ ...SECURITY, ...data }));
    const out = await approvalCategoryService.update(9, 1, { managerEmails: ['vahid@x.io', 'susan@x.io'] });
    expect(out.tiers[0].managerEmails).toEqual(['vahid@x.io', 'susan@x.io']);
    expect(out.tiers[1]).toEqual(SECURITY.tiers[1]);
  });

  test('categoryTiers falls back to a single tier for pre-v2 rows', () => {
    expect(categoryTiers({ managerEmails: ['A@x.io'], tiers: null })).toEqual([{ name: 'Tier 1', managerEmails: ['a@x.io'], limit: null }]);
    expect(categoryTiers({ managerEmails: ['a@x.io'], tiers: [] })).toEqual([{ name: 'Tier 1', managerEmails: ['a@x.io'], limit: null }]);
  });
});

describe('e-mail renderers + helpers', () => {
  test('formatAmount', () => {
    expect(formatAmount(1234.5, 'CAD')).toBe('$1,234.50');
    expect(formatAmount(20, 'USD')).toBe('US$20.00');
    expect(formatAmount(null)).toBeNull();
    expect(formatAmount('abc')).toBeNull();
  });

  test('approver e-mail shows the hand-off block and the amount fact', () => {
    const html = renderApproverRequestEmail({
      ticket: { ref: 'TP-1', subject: 'S' }, requester: { name: 'Rita' }, requestedByName: 'Req',
      amountLabel: '$6,000.00', tierLabel: 'Tier 2', decisionUrl: 'https://x/approval/t',
      handoff: { kind: 'forwarded', byName: 'Neville', note: 'Your line' },
    });
    expect(html).toContain('$6,000.00');
    expect(html).toContain('Tier 2');
    expect(html).toContain('forwarded this request to you');
    expect(html).toContain('Your line');
  });

  test('requester hand-off e-mail names the new approver and never the note', () => {
    const html = renderRequesterHandoffEmail({ ticket: { ref: 'TP-1', subject: 'S', appUrl: 'https://x/tickets/1' }, kind: 'escalated', byName: 'Vahid', toNames: ['Neville'], toTierName: 'Tier 2', requester: { name: 'Rita' } });
    expect(html).toContain('escalated your approval request');
    expect(html).toContain('Neville');
  });

  test('fast-sync cron helpers', () => {
    expect(clampFastSyncInterval(undefined)).toBe(1);
    expect(clampFastSyncInterval('5')).toBe(5);
    expect(clampFastSyncInterval(99)).toBe(30);
    expect(fastSyncCronExpression(1, 13)).toBe('13 * * * * *');
    expect(fastSyncCronExpression(5, 13)).toBe('13 */5 * * * *');
  });
});
