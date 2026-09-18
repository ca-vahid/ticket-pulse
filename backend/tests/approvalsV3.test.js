import { jest } from '@jest/globals';

/**
 * Approvals v3 (16 Sep 2026): the conversation loop — questions with an
 * audience, answers by link / mailbox / app, approve-with-condition, decision
 * thread e-mails, and a tier-N approver requesting on their own category.
 */

const prismaMock = {
  ticket: { findFirst: jest.fn(), findUnique: jest.fn() },
  approvalCategory: { findFirst: jest.fn(), findUnique: jest.fn() },
  ticketApproval: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  approvalMessage: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  approvalReplyToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
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
const azureAdMock = { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn(), resolveAddress: jest.fn() };
const mailMock = { deliverTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }), sendTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };
const directoryMock = { resolvePersonName: jest.fn(async (e) => ({ 'rita@x.io': 'Rita Requester', 'req@x.io': 'Mehdi Agent', 'vahid@x.io': 'Vahid', 'neville@x.io': 'Neville' }[String(e).toLowerCase()] || null)), fillPersonNames: jest.fn(async (rows) => rows) };
const signatureMock = { getEnabledSignatureForSend: jest.fn().mockResolvedValue(null) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: sendgridMock, sendEmail: sendgridMock.sendEmail }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: lifecycleMock }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => publicStatusMock);
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: azureAdMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/personDirectoryService.js', () => directoryMock);
jest.unstable_mockModule('../src/services/userSignatureService.js', () => signatureMock);

const { default: conversation, plusAddressApprovalKey } = await import('../src/services/approvalConversationService.js');
const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');
const { descriptionHtmlForEmail, renderApprovalMessageEmail, renderDecisionThreadEmail, renderApproverRequestEmail, renderRequesterDecisionEmail } = await import('../src/services/approvalEmailTemplate.js');

const ticket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1234, subject: 'New laptop', status: 'Open', priority: 2,
  requester: { name: 'Rita Requester', email: 'rita@x.io' }, workspace: { name: 'IT', slug: 'it' },
};
const SECURITY = {
  id: 9, workspaceId: 1, name: 'Security', isActive: true, hasAmount: false, amountCurrency: 'CAD', managerEmails: ['vahid@x.io'],
  tiers: [{ name: 'Tier 1', managerEmails: ['vahid@x.io'], limit: null }, { name: 'Tier 2', managerEmails: ['neville@x.io'], limit: null }],
};
const row = (over = {}) => ({
  id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approvalCategoryId: 9, tier: 2, isFinal: false,
  approverEmail: 'neville@x.io', approverName: 'Neville', requestedBy: 'req@x.io', requestGroupId: 'grp-1',
  requestNote: 'Please approve', requestNoteHtml: null, amount: null, amountCurrency: null, escalationLog: null, clarificationLog: [],
  expiresAt: new Date(Date.now() + 86400000), ...over,
});
const groupRows = [
  { id: 1, approverEmail: 'vahid@x.io', approverName: 'Vahid', tier: 1, status: 'escalated' },
  { id: 2, approverEmail: 'neville@x.io', approverName: 'Neville', tier: 2, status: 'pending' },
];

let msgSeq = 500;
beforeEach(() => {
  jest.clearAllMocks();
  msgSeq = 500;
  activityMock.create.mockResolvedValue({});
  prismaMock.ticket.findFirst.mockResolvedValue(ticket);
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.approvalCategory.findFirst.mockResolvedValue(SECURITY);
  prismaMock.approvalCategory.findUnique.mockResolvedValue(SECURITY);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 3, address: 'ticketpulse@x.io', mode: 'ingest', isEnabled: true });
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticketApproval.findMany.mockResolvedValue(groupRows);
  prismaMock.ticketApproval.findFirst.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  publicStatusMock.getPublicTicketStatusSettings.mockResolvedValue({ enabled: false, showRequesterEmail: false });
  prismaMock.approvalMessage.create.mockImplementation(({ data }) => Promise.resolve({ id: ++msgSeq, createdAt: new Date(), ...data }));
  prismaMock.approvalMessage.findMany.mockResolvedValue([]);
  prismaMock.approvalMessage.update.mockResolvedValue({});
  prismaMock.approvalReplyToken.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, ...data }));
  prismaMock.approvalReplyToken.update.mockResolvedValue({});
  let seq = 100;
  prismaMock.ticketApproval.create.mockImplementation(({ data }) => Promise.resolve({ id: ++seq, ...data }));
  prismaMock.ticketApproval.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
  mailMock.deliverTransactionalEmail.mockResolvedValue({ sent: true });
  mailMock.sendTransactionalEmail.mockResolvedValue({ sent: true });
});

describe('plusAddressApprovalKey', () => {
  test('reads the +ap<key> on the recipient side, only for the workspace mailbox', () => {
    expect(plusAddressApprovalKey({ to: ['"TP" <ticketpulse+ap0123456789ab@x.io>'] }, 'ticketpulse@x.io')).toBe('0123456789ab');
    expect(plusAddressApprovalKey({ to: 'someone@x.io', cc: 'ticketpulse+apABCDEF012345@x.io' }, 'ticketpulse@x.io')).toBe('abcdef012345');
    expect(plusAddressApprovalKey({ to: ['other+ap0123456789ab@x.io'] }, 'ticketpulse@x.io')).toBeNull();
    expect(plusAddressApprovalKey({ to: ['ticketpulse+tp1234@x.io'] }, 'ticketpulse@x.io')).toBeNull();
  });
});

describe('postMessage — ask the requester', () => {
  test('To requester, Cc agent + the rest of the chain; parks the request; one reply token + e-mail per recipient with a plus-address Reply-To', async () => {
    const approval = row();
    const res = await conversation.postMessage(approval, { kind: 'question', mode: 'requester', bodyText: 'Which environments?', via: 'link', author: { email: 'neville@x.io', name: 'Neville' } });
    expect(res.kind).toBe('question');
    expect(res.audience).toBe('requester');
    expect(res.to).toEqual(['rita@x.io']);
    expect(res.cc.sort()).toEqual(['req@x.io', 'vahid@x.io']);
    // parked + legacy clarification log kept in step
    const upd = prismaMock.ticketApproval.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 2 });
    expect(upd.data.status).toBe('info_requested');
    expect(upd.data.clarificationLog[0]).toMatchObject({ question: 'Which environments?', askedBy: 'neville@x.io', messageId: 501 });
    // private ticket note
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isPrivate: true, bodyText: expect.stringContaining('Question from Neville') }) }));
    // tokens + e-mails: three recipients
    expect(prismaMock.approvalReplyToken.create).toHaveBeenCalledTimes(3);
    const tokenRows = prismaMock.approvalReplyToken.create.mock.calls.map((c) => c[0].data);
    expect(tokenRows.map((t) => t.recipientEmail).sort()).toEqual(['req@x.io', 'rita@x.io', 'vahid@x.io']);
    expect(tokenRows[0].plusKey).toMatch(/^[a-f0-9]{12}$/);
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(3);
    const first = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(first.replyTo).toBe(`ticketpulse+ap${tokenRows[0].plusKey}@x.io`);
    expect(first.html).toContain('/approval-reply/');
    expect(first.html).toContain('simply reply to this e-mail');
    expect(first.subject).toMatch(/^Question on Security approval: New laptop \[TP-1234\]$/);
  });

  test('untick a chip: an explicit To/Cc narrows the recipients but the requester must stay in To', async () => {
    const approval = row();
    const res = await conversation.postMessage(approval, { mode: 'requester', to: ['rita@x.io'], cc: ['req@x.io'], bodyText: 'q', author: { email: 'neville@x.io' } });
    expect(res.to).toEqual(['rita@x.io']);
    expect(res.cc).toEqual(['req@x.io']);
    await expect(conversation.postMessage(approval, { mode: 'requester', to: [], cc: ['req@x.io'], bodyText: 'q', author: { email: 'neville@x.io' } }))
      .rejects.toThrow(/needs the requester in To/);
  });

  test('a question needs a body and an open request', async () => {
    await expect(conversation.postMessage(row(), { mode: 'requester', bodyText: '   ', author: { email: 'neville@x.io' } })).rejects.toThrow(/Type your question/);
    await expect(conversation.postMessage(row({ status: 'approved' }), { mode: 'requester', bodyText: 'q', author: { email: 'neville@x.io' } })).rejects.toThrow(/already approved/);
  });
});

describe('postMessage — ask the approvers / agent only', () => {
  test('internal audience: never the requester (even when listed), status stays pending, e-mails flagged internal', async () => {
    const approval = row();
    const res = await conversation.postMessage(approval, { mode: 'internal', to: ['rita@x.io', 'vahid@x.io'], bodyText: 'Did we budget this?', author: { email: 'neville@x.io', name: 'Neville' } });
    expect(res.audience).toBe('internal');
    expect(res.to).toEqual(['vahid@x.io']);
    expect(res.cc).toEqual([]);
    expect(prismaMock.ticketApproval.update).not.toHaveBeenCalled();
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(mailMock.deliverTransactionalEmail.mock.calls[0][0].to).toEqual(['vahid@x.io']);
    expect(mailMock.deliverTransactionalEmail.mock.calls[0][0].html).toContain('the ticket requester is not on this message');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyText).toContain('(approvers + agent only)');
  });

  test('defaults to the agent + the rest of the chain', async () => {
    const res = await conversation.postMessage(row(), { mode: 'internal', bodyText: 'q', author: { email: 'neville@x.io' } });
    expect(res.to.sort()).toEqual(['req@x.io', 'vahid@x.io']);
  });
});

describe('listForGroup / awaitingApprover', () => {
  test('the requester audience never sees internal messages; an open internal question = waiting on approver', async () => {
    prismaMock.approvalMessage.findMany.mockImplementation(({ where }) => Promise.resolve([
      { id: 1, kind: 'question', audience: 'internal', authorEmail: 'neville@x.io', requestGroupId: 'grp-1', createdAt: new Date() },
      { id: 2, kind: 'question', audience: 'requester', authorEmail: 'neville@x.io', requestGroupId: 'grp-1', createdAt: new Date() },
    ].filter((m) => !where.audience || m.audience === where.audience)));
    const forRequester = await conversation.listForGroup('grp-1', { audience: 'requester' });
    expect(forRequester.map((m) => m.id)).toEqual([2]);
    expect(prismaMock.approvalMessage.findMany.mock.calls[0][0].where).toEqual({ requestGroupId: 'grp-1', audience: 'requester' });
    const all = await conversation.listForGroup('grp-1');
    expect(all.map((m) => m.id)).toEqual([1, 2]);
    await expect(conversation.awaitingApprover('grp-1')).resolves.toBe(true);
    prismaMock.approvalMessage.findMany.mockResolvedValue([
      { id: 1, kind: 'question', audience: 'internal', inReplyToId: null }, { id: 3, kind: 'answer', audience: 'internal', inReplyToId: 1 },
    ]);
    await expect(conversation.awaitingApprover('grp-1')).resolves.toBe(false);
  });
});

describe('answer', () => {
  const question = { id: 501, kind: 'question', audience: 'requester', requestGroupId: 'grp-1', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Which environments?', createdAt: new Date('2026-09-16T10:00:00Z'), toEmails: ['rita@x.io'], ccEmails: ['req@x.io', 'vahid@x.io'] };
  beforeEach(() => {
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue({ id: 77, messageId: 501, recipientEmail: 'rita@x.io', requestGroupId: 'grp-1', expiresAt: new Date(Date.now() + 86400000) });
    prismaMock.approvalMessage.findUnique.mockResolvedValue(question);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'info_requested', clarificationLog: [{ question: 'Which environments?', askedBy: 'neville@x.io', messageId: 501, answer: null }] }));
  });

  test('by mailbox reply (plus key): strips the quoted history, records the answer, un-parks the request and re-issues the approver link', async () => {
    prismaMock.ticketApproval.findMany
      .mockResolvedValueOnce(groupRows) // participants
      .mockResolvedValueOnce([row({ status: 'info_requested', clarificationLog: [{ question: 'Which environments?', askedBy: 'neville@x.io', messageId: 501, answer: null }] })]) // parked rows
      .mockResolvedValueOnce([row({ status: 'info_requested' })]); // open rows for the re-issue
    const res = await conversation.answer({
      plusKey: 'abcdef012345', senderEmail: 'Rita@x.io', senderName: 'Rita Requester', via: 'email', emailMessageId: '<m1@x.io>',
      bodyText: 'DEV and UAT only.\n\nOn Tue, Neville wrote:\n> Which environments?',
    });
    expect(prismaMock.approvalReplyToken.findUnique).toHaveBeenCalledWith({ where: { plusKey: 'abcdef012345' } });
    expect(res.message.kind).toBe('answer');
    expect(res.message.audience).toBe('requester');
    expect(res.message.bodyText).toBe('DEV and UAT only.');
    expect(res.message.author).toEqual({ email: 'rita@x.io', name: 'Rita Requester', role: 'requester' });
    expect(res.message.inReplyToId).toBe(501);
    expect(prismaMock.approvalMessage.create.mock.calls[0][0].data).toMatchObject({ via: 'email', emailMessageId: '<m1@x.io>', toEmails: ['neville@x.io'] });
    expect(prismaMock.approvalReplyToken.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 77 } }));
    // parked row → pending with the answer stamped on the legacy log
    const unpark = prismaMock.ticketApproval.update.mock.calls.find((c) => c[0].data.status === 'pending');
    expect(unpark).toBeTruthy();
    expect(unpark[0].data.clarificationLog[0]).toMatchObject({ answer: 'DEV and UAT only.', answeredBy: 'rita@x.io' });
    // the open approver gets a fresh link with the Q&A (reissueLinkWithAnswer → _emailApprover → sendgrid lane)
    const reissue = prismaMock.ticketApproval.update.mock.calls.find((c) => c[0].data.tokenHash);
    expect(reissue).toBeTruthy();
    const reissued = mailMock.sendTransactionalEmail.mock.calls.find((c) => c[0].label === 'approval');
    expect(reissued).toBeTruthy();
    expect(reissued[0].to).toBe('neville@x.io');
    expect(reissued[0].html).toContain('DEV and UAT only.');
  });

  test('by link (token): the token recipient is the author; a stranger with no token is refused', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue(groupRows);
    const res = await conversation.answer({ token: 'tok', bodyText: 'Yes', via: 'link' });
    expect(prismaMock.approvalReplyToken.findUnique).toHaveBeenCalledWith({ where: { tokenHash: expect.any(String) } });
    expect(res.message.author.email).toBe('rita@x.io');
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue(null);
    await expect(conversation.answer({ token: 'nope', bodyText: 'Yes' })).rejects.toThrow(/not valid/);
    await expect(conversation.answer({ plusKey: 'abcdef012345', senderEmail: 'stranger@x.io', bodyText: 'hi' })).rejects.toThrow(/not valid/);
  });

  test('an internal question answered by the agent stays internal', async () => {
    prismaMock.approvalMessage.findUnique.mockResolvedValue({ ...question, audience: 'internal', toEmails: ['req@x.io'], ccEmails: [] });
    prismaMock.ticketApproval.findMany.mockResolvedValue(groupRows);
    const res = await conversation.answer({ inReplyToId: 501, senderEmail: 'req@x.io', senderName: 'Mehdi Agent', bodyText: 'Yes, line IT-204.', via: 'app' });
    expect(res.message.audience).toBe('internal');
    expect(res.message.author.role).toBe('agent');
  });

  test('an expired reply token is refused with a clear message', async () => {
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue({ id: 77, messageId: 501, recipientEmail: 'rita@x.io', expiresAt: new Date(Date.now() - 1000) });
    await expect(conversation.answer({ token: 'old', bodyText: 'x' })).rejects.toThrow(/expired/);
  });
});

describe('viewForReplyToken', () => {
  test('returns the question, the audience-filtered thread and who the recipient is', async () => {
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue({ id: 77, messageId: 501, recipientEmail: 'rita@x.io', requestGroupId: 'grp-1', expiresAt: null });
    prismaMock.approvalMessage.findUnique.mockResolvedValue({ id: 501, kind: 'question', audience: 'requester', requestGroupId: 'grp-1', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'q', createdAt: new Date(), toEmails: ['rita@x.io'], ccEmails: [] });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'info_requested' }));
    prismaMock.approvalMessage.findMany.mockResolvedValue([]);
    const v = await conversation.viewForReplyToken('tok');
    expect(v.recipient).toEqual({ email: 'rita@x.io', name: 'Rita Requester', role: 'requester' });
    expect(v.question.bodyText).toBe('q');
    expect(v.ticket.displayRef).toBe('TP-1234');
    expect(v.approval.category).toBe('Security');
    expect(prismaMock.approvalMessage.findMany.mock.calls[0][0].where).toEqual({ requestGroupId: 'grp-1', audience: 'requester' });
  });
});

describe('request() by a tier-1 approver on their own category', () => {
  test('starts at Tier 2 with an auto_start hand-off, tells the approver why, and returns the skip', async () => {
    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 9, note: 'Need this' }, { email: 'vahid@x.io', name: 'Vahid', role: 'admin' });
    expect(res.startedAtTier).toBe(2);
    expect(res.startedAtTierName).toBe('Tier 2');
    expect(res.skippedTiers).toEqual(['Tier 1']);
    expect(res.approvals).toEqual([{ id: 101, approverEmail: 'neville@x.io' }]);
    const created = prismaMock.ticketApproval.create.mock.calls[0][0].data;
    expect(created.tier).toBe(2);
    expect(created.escalationLog[0]).toMatchObject({ kind: 'auto_start', fromTier: 1, toTier: 2, byEmail: 'vahid@x.io', toEmails: ['neville@x.io'] });
    expect(created.escalationLog[0].reason).toMatch(/Vahid is an approver on Tier 1/);
    // the approver e-mail says why it came to them directly
    const sent = mailMock.sendTransactionalEmail.mock.calls.find((c) => c[0].label === 'approval');
    expect(sent[0].to).toBe('neville@x.io');
    expect(sent[0].html).toContain('comes to you at <b>Tier 2</b> directly');
    // the skip is recorded on the ticket
    const note = prismaMock.ticketThreadEntry.create.mock.calls.find((c) => c[0].data.rawPayload?.event === 'auto_start');
    expect(note[0].data.bodyText).toMatch(/started at Tier 2 \(neville@x.io\)/);
    expect(activityMock.create.mock.calls[0][0].details).toMatchObject({ startedAtTier: 2, skippedTiers: ['Tier 1'] });
  });

  test('a non-approver still starts at Tier 1; someone on every tier is refused', async () => {
    const res = await ticketApprovalService.request(501, 1, { approvalCategoryId: 9 }, { email: 'req@x.io', name: 'Mehdi' });
    expect(res.startedAtTier).toBe(1);
    expect(res.skippedTiers).toEqual([]);
    expect(prismaMock.ticketApproval.create.mock.calls[0][0].data.escalationLog).toBeUndefined();
    prismaMock.approvalCategory.findFirst.mockResolvedValue({ ...SECURITY, tiers: [{ name: 'Tier 1', managerEmails: ['vahid@x.io'] }, { name: 'Tier 2', managerEmails: ['vahid@x.io'] }] });
    await expect(ticketApprovalService.request(501, 1, { approvalCategoryId: 9 }, { email: 'vahid@x.io' })).rejects.toThrow(/approver on every tier/);
  });
});

describe('decide with a condition', () => {
  test('stores the condition + signature, records a decision message, and e-mails the requester and the other approvers with their own history', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    prismaMock.approvalMessage.findMany.mockImplementation(({ where }) => Promise.resolve([
      { id: 1, kind: 'question', audience: 'internal', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Budget?', requestGroupId: 'grp-1', createdAt: new Date() },
      { id: 2, kind: 'question', audience: 'requester', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Which env?', requestGroupId: 'grp-1', createdAt: new Date() },
    ].filter((m) => !where.audience || m.audience === where.audience)));
    signatureMock.getEnabledSignatureForSend.mockResolvedValue({ html: '<p><b>Neville</b> · CISO</p>' });

    const updated = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'Go ahead', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, { conditionNote: 'UAT only', conditionNoteHtml: '<p>UAT <b>only</b></p>' });
    expect(updated.status).toBe('approved');
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ conditionNote: 'UAT only', signatureHtml: '<p><b>Neville</b> · CISO</p>' });
    expect(data.conditionNoteHtml).toContain('UAT <b>only</b>');
    // ticket note names the condition
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyText).toMatch(/APPROVED WITH CONDITION ✔ by Neville — "Go ahead" · Condition: "UAT only"/);
    // decision message
    const decision = prismaMock.approvalMessage.create.mock.calls.find((c) => c[0].data.kind === 'decision');
    expect(decision[0].data).toMatchObject({ audience: 'requester', authorEmail: 'neville@x.io', bodyText: 'Approved with condition\nCondition: UAT only\nGo ahead' });
    // e-mails: the agent (existing lane) + requester + Vahid (the other approver)
    const sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'rita@x.io', 'vahid@x.io']);
    const agent = sends.find((s) => s.to === 'req@x.io');
    expect(agent.subject).toMatch(/^Approved with condition: your approval request/);
    expect(agent.html).toContain('UAT only');
    expect(agent.html).toContain('CISO');
    const rita = sends.find((s) => s.to === 'rita@x.io');
    expect(rita.subject).toBe('Approved with condition: New laptop [TP-1234]');
    expect(rita.html).toContain('Hi Rita,');
    expect(rita.html).toContain('Which env?');
    expect(rita.html).not.toContain('Budget?'); // internal history never reaches the requester
    expect(rita.html).not.toContain('/tickets/501'); // no app link for the requester
    const vahid = sends.find((s) => s.to === 'vahid@x.io');
    expect(vahid.html).toContain('Budget?');
    expect(vahid.html).toContain('(internal)');
    expect(vahid.html).toContain('/tickets/501');
  });

  test('a rejection ignores any condition and still fans out', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'No', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, { conditionNote: 'ignored' });
    expect(prismaMock.ticketApproval.update.mock.calls[0][0].data.conditionNote).toBeNull();
    const sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'rita@x.io', 'vahid@x.io']);
    expect(sends.find((s) => s.to === 'rita@x.io').subject).toBe('Not approved: New laptop [TP-1234]');
  });
});

describe('e-mail templates (v3)', () => {
  test('descriptionHtmlForEmail keeps lists / bold / code, restyles headings, and cuts long text on a block', () => {
    const r = descriptionHtmlForEmail('<p>Intro</p><ul><li>DEV: <code>a.b</code></li><li><b>UAT</b></li></ul><h2>Details</h2><p style="color:red">x</p>');
    expect(r.truncated).toBe(false);
    expect(r.html).toContain('<ul style=');
    expect(r.html).toContain('<li style=');
    expect(r.html).toContain('<b>UAT</b>');
    expect(r.html).toContain('<code style=');
    expect(r.html).toContain('<h3 style=');
    expect(r.html).not.toContain('color:red');
    const long = descriptionHtmlForEmail(Array.from({ length: 60 }, (_, i) => `<p>${'word '.repeat(40)}${i}</p>`).join(''), { maxChars: 1500 });
    expect(long.truncated).toBe(true);
    expect(long.html.length).toBeLessThan(3000);
    expect(long.html.endsWith('</p>')).toBe(true);
    expect(descriptionHtmlForEmail('plain\nlines').html).toBe('<p style="margin:0 0 10px">plain<br />lines</p>');
    expect(descriptionHtmlForEmail('').html).toBe('');
  });

  test('the approver e-mail renders the description formatted, not as a flattened excerpt', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-9', subject: 'x', description: '<p>One</p><ul><li>Two</li></ul>' }, decisionUrl: 'https://app/a', noteHtml: '', otherApprovers: [] });
    expect(html).toContain('Ticket description');
    expect(html).toContain('<li style="margin:0 0 4px">Two</li>');
    expect(html).not.toContain('white-space:pre-line');
  });

  test('renderApprovalMessageEmail: question with Answer button + reply-by-mail hint, internal flag, earlier thread', () => {
    const html = renderApprovalMessageEmail({
      kind: 'question', audience: 'internal', authorName: 'Neville', authorRole: 'approver', recipient: { email: 'v@x.io', name: 'Vahid' }, isCc: false,
      categoryName: 'Security', ticket: { ref: 'TP-1', subject: 'Laptop' }, bodyText: 'Budget?', replyUrl: 'https://app/approval-reply/t', canReplyByEmail: true, internalNote: true,
      thread: [{ kind: 'question', author: { name: 'Neville' }, bodyText: 'Earlier q', createdAt: '2026-09-16T10:00:00Z', audience: 'requester' }],
    });
    expect(html).toContain('<b>Neville</b> has a question for you:');
    expect(html).toContain('Budget?');
    expect(html).toContain('https://app/approval-reply/t');
    expect(html).toContain('simply reply to this e-mail');
    expect(html).toContain('the ticket requester is not on this message');
    expect(html).toContain('Earlier on this request');
    expect(html).toContain('Earlier q');
    const noMail = renderApprovalMessageEmail({ kind: 'answer', authorName: 'Rita', recipient: { name: 'Neville' }, ticket: { ref: 'TP-1' }, bodyText: 'DEV only', replyUrl: 'https://app/r', canReplyByEmail: false });
    expect(noMail).toContain('<b>Rita</b> answered your question:');
    expect(noMail).toContain('this mailbox does not read replies');
  });

  test('renderDecisionThreadEmail: verdict, condition, note, signature, quoted history newest first, no app link for the requester', () => {
    const html = renderDecisionThreadEmail({
      workspaceName: 'IT', categoryName: 'Security', ticket: { ref: 'TP-1', subject: 'Laptop', appUrl: null },
      approved: true, approverName: 'Neville', note: 'Go ahead', conditionNote: 'UAT only', signatureHtml: '<p>Neville · CISO</p>',
      recipient: { role: 'requester', name: 'Rita Requester' }, requester: { name: 'Rita Requester' },
      requestNote: 'Please approve', requestedByName: 'Mehdi',
      thread: [
        { kind: 'question', author: { name: 'Neville' }, bodyText: 'Which env?', createdAt: '2026-09-16T10:00:00Z' },
        { kind: 'answer', author: { name: 'Rita' }, bodyText: 'DEV only', createdAt: '2026-09-16T11:00:00Z' },
      ],
    });
    expect(html).toContain('Hi Rita,');
    expect(html).toContain('<b>Neville</b> has <span');
    expect(html).toContain('approved with condition</span> the request.');
    expect(html).toContain('UAT only');
    expect(html).toContain('Go ahead');
    expect(html).toContain('Neville · CISO');
    expect(html).toContain('History');
    expect(html.indexOf('DEV only')).toBeLessThan(html.indexOf('Which env?')); // newest first
    expect(html).toContain('asked for approval:');
    expect(html).not.toContain('Open the ticket');
    const rejected = renderDecisionThreadEmail({ ticket: { ref: 'TP-1', subject: 'x', appUrl: 'https://app/t/1' }, approved: false, approverName: 'N', recipient: { role: 'approver', name: 'Vahid' }, thread: [] });
    expect(rejected).toContain('not approved</span> the request'); // reads "N has not approved the request"
    expect(rejected).toContain('Open the ticket');
  });

  test('the agent decision e-mail shows the condition and the signature', () => {
    const html = renderRequesterDecisionEmail({ ticket: { ref: 'TP-1', subject: 'x' }, approved: true, approverName: 'Neville', conditionNote: 'UAT only', signatureHtml: '<p>Sig</p>', requester: { name: 'Rita' } });
    expect(html).toContain('Approved with condition');
    expect(html).toContain('Condition');
    expect(html).toContain('UAT only');
    expect(html).toContain('<p>Sig</p>');
  });
});
