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
  approvalMessage: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  approvalReplyToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  ticketThreadEntry: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
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
// The full export list ticketService imports, so the reply-format history (_lastInboundQuote) loads.
const signatureMock = {
  getEnabledSignatureForSend: jest.fn().mockResolvedValue(null),
  appendSignatureToEmail: jest.fn((email, sig) => ({ ...email, html: `${email.html || ''}${sig?.html ? `<br>${sig.html}` : ''}` })),
  signatureAsSent: jest.fn(() => null),
  trimTrailingBlankHtml: jest.fn((h) => h),
  closeLastParagraphTight: jest.fn((h) => h),
};

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
  // The reply-format history (_lastInboundQuote): no public ticket mail, so it quotes the approval messages.
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.count.mockResolvedValue(0);
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
  test('To requester, Cc agent + the rest of the chain; parks the request; ONE e-mail in the reply format, author copied, plus-address Reply-To', async () => {
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
    // one token (the requester's) and ONE e-mail to everyone, like a ticket reply (27 Oct 2026)
    expect(prismaMock.approvalReplyToken.create).toHaveBeenCalledTimes(1);
    const tokenRow = prismaMock.approvalReplyToken.create.mock.calls[0][0].data;
    expect(tokenRow.recipientEmail).toBe('rita@x.io');
    expect(tokenRow.plusKey).toMatch(/^[a-f0-9]{12}$/);
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(1);
    const mail = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['rita@x.io']);
    expect(mail.cc.sort()).toEqual(['neville@x.io', 'req@x.io', 'vahid@x.io']);
    expect(mail.replyTo).toBe(`ticketpulse+ap${tokenRow.plusKey}@x.io`);
    expect(mail.subject).toBe('Re: New laptop [TP-1234]');
    expect(mail.ticket).toMatchObject({ id: 501 });
    expect(mail.html).toContain('Which environments?');
    expect(mail.html).toContain('Just reply to this e-mail to answer.');
    expect(mail.html).toContain('The request is on hold until then.');
    expect(mail.html).not.toContain('/approval-reply/');
    expect(mail.html).not.toContain('Question on an approval');
    // the author is copied on the e-mail but not stored as a recipient
    expect(res.cc).not.toContain('neville@x.io');
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
    const mail = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['vahid@x.io']);
    // 26 Oct 2026: the reply format for the internal audience — same token + plus-address as before.
    const tokenRow = prismaMock.approvalReplyToken.create.mock.calls[0][0].data;
    expect(tokenRow).toMatchObject({ recipientEmail: 'vahid@x.io' });
    expect(mail.replyTo).toBe(`ticketpulse+ap${tokenRow.plusKey}@x.io`);
    expect(mail.subject).toBe('Re: New laptop [TP-1234]');
    expect(mail.fromName).toBe('Neville via Ticket Pulse');
    expect(mail.html).toContain('Did we budget this?');
    expect(mail.html).toContain('/approval-reply/');
    expect(mail.html).toContain('Internal: Rita is not on this conversation.');
    expect(mail.html).not.toContain('Question on an approval');
    expect(mail.cc || []).toEqual([]);
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyText).toContain('(approvers + agent only)');
  });

  test('a rich question reaches the ticket note as rich text, quoted under its header line (7 Oct 2026)', async () => {
    const html = '<p>Hi Andrii,</p><p><strong>BGC4333 looks healthy.</strong></p><table><tr><th>Component</th><th>Specs</th></tr><tr><td>Memory</td><td><strong>32 GB</strong></td></tr></table>';
    await conversation.postMessage(row(), { mode: 'internal', to: ['vahid@x.io'], bodyHtml: html, author: { email: 'neville@x.io', name: 'Neville' } });
    const data = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data;
    expect(data.bodyText).toContain('Question (approvers + agent only) from Neville');
    expect(data.bodyHtml).toMatch(/^<p>Question \(approvers \+ agent only\) from Neville → [^<]+:<\/p><blockquote>/);
    expect(data.bodyHtml).toContain('<table>');
    expect(data.bodyHtml).toContain('<strong>32 GB</strong>');
  });

  test('a plain-text question keeps a plain note (no HTML invented)', async () => {
    await conversation.postMessage(row(), { mode: 'internal', to: ['vahid@x.io'], bodyText: 'q', author: { email: 'neville@x.io' } });
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyHtml).toBeUndefined();
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

describe('askRequesterInstead (27 Oct 2026)', () => {
  const internalQ = (over = {}) => ({
    id: 70, workspaceId: 1, ticketId: 501, approvalId: 2, requestGroupId: 'grp-1', kind: 'question', audience: 'internal',
    authorEmail: 'neville@x.io', authorName: 'Neville', authorRole: 'approver',
    bodyText: 'Who will use it?', bodyHtml: '<ul><li>Who will use it?</li></ul>',
    toEmails: ['req@x.io', 'vahid@x.io'], ccEmails: [], ...over,
  });

  test('the asker’s own question goes to the requester, the earlier recipients copied; the internal one is closed', async () => {
    prismaMock.approvalMessage.findUnique.mockResolvedValue(internalQ());
    prismaMock.approvalMessage.findFirst.mockResolvedValue(null);
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    const res = await conversation.askRequesterInstead(70, { email: 'vahid@x.io', name: 'Vahid', role: 'admin' });
    expect(res).toMatchObject({ kind: 'question', audience: 'requester', to: ['rita@x.io'] });
    expect(res.author).toMatchObject({ email: 'neville@x.io', name: 'Neville' });
    expect(res.cc.sort()).toEqual(['req@x.io', 'vahid@x.io']);
    // Neville's row waits on the requester
    expect(prismaMock.ticketApproval.update.mock.calls[0][0]).toMatchObject({ where: { id: 2 }, data: { status: 'info_requested' } });
    // ONE reply-format e-mail: To Rita, Cc the agent, Vahid and the asker
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(1);
    const mail = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(mail.to).toEqual(['rita@x.io']);
    expect(mail.cc.sort()).toEqual(['neville@x.io', 'req@x.io', 'vahid@x.io']);
    expect(mail.html).toContain('Who will use it?');
    // the internal question is answered with where it went
    const closing = prismaMock.approvalMessage.create.mock.calls.map((c) => c[0].data).find((d) => d.kind === 'answer');
    expect(closing).toMatchObject({ inReplyToId: 70, audience: 'internal', authorEmail: 'vahid@x.io' });
    expect(closing.bodyText).toContain('Sent to Rita Requester');
  });

  test('refuses a question already with the requester, one already answered, and someone outside the request', async () => {
    prismaMock.ticketApproval.findUnique.mockResolvedValue(row());
    prismaMock.approvalMessage.findUnique.mockResolvedValue(internalQ({ audience: 'requester' }));
    await expect(conversation.askRequesterInstead(70, { email: 'vahid@x.io' })).rejects.toThrow(/already went to the requester/);
    prismaMock.approvalMessage.findUnique.mockResolvedValue(internalQ());
    prismaMock.approvalMessage.findFirst.mockResolvedValue({ id: 71 });
    await expect(conversation.askRequesterInstead(70, { email: 'vahid@x.io' })).rejects.toThrow(/already answered/);
    prismaMock.approvalMessage.findFirst.mockResolvedValue(null);
    await expect(conversation.askRequesterInstead(70, { email: 'stranger@x.io' })).rejects.toThrow(/Only someone on this request/);
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('answer', () => {
  const question = { id: 501, kind: 'question', audience: 'requester', requestGroupId: 'grp-1', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Which environments?', createdAt: new Date('2026-09-16T10:00:00Z'), toEmails: ['rita@x.io'], ccEmails: ['req@x.io', 'vahid@x.io'] };
  beforeEach(() => {
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue({ id: 77, messageId: 501, recipientEmail: 'rita@x.io', requestGroupId: 'grp-1', expiresAt: new Date(Date.now() + 86400000) });
    prismaMock.approvalMessage.findUnique.mockResolvedValue(question);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'info_requested', clarificationLog: [{ question: 'Which environments?', askedBy: 'neville@x.io', messageId: 501, answer: null }] }));
  });

  test('by mailbox reply (plus key): strips the quoted history, records the answer, un-parks the request; a plain Reply is passed on to the others as the next e-mail', async () => {
    prismaMock.ticketApproval.findMany
      .mockResolvedValueOnce(groupRows) // participants
      .mockResolvedValueOnce([row({ status: 'info_requested', clarificationLog: [{ question: 'Which environments?', askedBy: 'neville@x.io', messageId: 501, answer: null }] })]); // parked rows
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
    // no separate "Answer on" card
    expect(mailMock.sendTransactionalEmail.mock.calls.find((c) => c[0].label === 'approval')).toBeFalsy();
    // nobody else was on the reply, so the answer goes on as the next e-mail:
    // the approver who now decides gets it alone, with a fresh decision link…
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(2);
    const [solo, shared] = mailMock.deliverTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(solo.to).toEqual(['neville@x.io']);
    expect(solo.cc).toEqual([]);
    expect(solo.fromName).toBe('Rita Requester via Ticket Pulse');
    expect(solo.subject).toBe('Re: New laptop [TP-1234]');
    expect(solo.html).toContain('DEV and UAT only.');
    expect(solo.html).toContain('Decide on this request');
    expect(solo.html).toMatch(/\/approval\/[A-Za-z0-9_-]+/);
    expect(prismaMock.ticketApproval.update.mock.calls.find((c) => c[0].where.id === 2 && c[0].data.tokenHash)).toBeTruthy();
    // …and the others share one, with no decision link
    expect(shared.to).toEqual(['req@x.io']);
    expect(shared.cc).toEqual(['vahid@x.io']);
    expect(shared.html).toContain('DEV and UAT only.');
    expect(shared.html).not.toContain('Decide on this request');
  });

  test('a Reply all already reached everyone: nothing more is sent', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValueOnce(groupRows).mockResolvedValueOnce([]);
    await conversation.answer({
      plusKey: 'abcdef012345', senderEmail: 'rita@x.io', senderName: 'Rita Requester', via: 'email',
      bodyText: 'DEV only.', seenBy: ['ticketpulse+abcdef012345@x.io', '"Neville" <neville@x.io>', 'req@x.io, vahid@x.io'],
    });
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a mail on the shared reply address from someone outside the request is refused', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue(groupRows);
    await expect(conversation.answer({ plusKey: 'abcdef012345', senderEmail: 'outsider@x.io', bodyText: 'hi', via: 'email' })).rejects.toThrow(/not part of this approval/);
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

  test('an internal answer (26 Oct 2026): the approver who decides gets it alone with a fresh decide link; the requester never', async () => {
    const internalQ = { ...question, audience: 'internal', authorEmail: 'vahid@x.io', authorName: 'Vahid', toEmails: ['req@x.io'], ccEmails: [] };
    prismaMock.approvalMessage.findUnique.mockResolvedValue(internalQ);
    prismaMock.approvalMessage.findMany.mockResolvedValue([internalQ]);
    msgSeq = 900; // the answer's id must not collide with the question's (501)
    prismaMock.ticketApproval.findMany.mockImplementation(({ where }) => Promise.resolve(where.status ? [row({ status: 'info_requested' })] : groupRows));
    await conversation.answer({ inReplyToId: 501, senderEmail: 'req@x.io', senderName: 'Mehdi Agent', bodyText: 'Yes, line IT-204.', via: 'app' });
    // no full request e-mail again; one answer e-mail per person
    expect(mailMock.sendTransactionalEmail.mock.calls.find((c) => c[0].label === 'approval')).toBeFalsy();
    const sent = mailMock.deliverTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sent.map((m) => m.to)).toEqual([['neville@x.io'], ['vahid@x.io']]);
    expect(sent.flatMap((m) => [...m.to, ...(m.cc || [])])).not.toContain('rita@x.io');
    const [toDecider, toAsker] = sent;
    expect(toDecider.fromName).toBe('Mehdi Agent via Ticket Pulse');
    expect(toDecider.label).toBe('approval answer');
    expect(toDecider.html).toContain('Yes, line IT-204.');
    expect(toDecider.html).toContain('Decide on this request');
    expect(toDecider.html).toContain('Internal: Rita is not on this conversation.');
    expect(toDecider.replyTo).toMatch(/^ticketpulse\+ap[a-f0-9]{12}@x\.io$/);
    // the parked row is back with the approver, on a fresh link
    expect(prismaMock.ticketApproval.update.mock.calls.find((c) => c[0].where.id === 2 && c[0].data.tokenHash && c[0].data.status === 'pending')).toBeTruthy();
    expect(toAsker.html).not.toContain('Decide on this request');
    // the question is in the history below the answer
    expect(toAsker.html).toContain('Which environments?');
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

const ANSWERED = {
  round: 1, setBy: 'neville@x.io', setByName: 'Neville', setAt: '2026-10-26T16:00:00.000Z', note: null,
  items: [{ id: 1, text: 'UAT only', response: 'can_meet', answer: 'Test environment first', answeredBy: 'req@x.io', answeredByName: 'Mehdi Agent', answeredAt: '2026-10-26T17:00:00.000Z' }],
  submittedAt: '2026-10-26T17:00:00.000Z', submittedBy: 'req@x.io', submittedByName: 'Mehdi Agent',
};
const AGREED = '1. UAT only\n   Can be met: Test environment first';

describe('decide with a condition', () => {
  test('accepting the answered conditions approves with the agreed list + signature, records a decision message, and e-mails the requester and the other approvers with their own history', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ conditions: ANSWERED }));
    prismaMock.approvalMessage.findMany.mockImplementation(({ where }) => Promise.resolve([
      { id: 1, kind: 'question', audience: 'internal', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Budget?', requestGroupId: 'grp-1', createdAt: new Date() },
      { id: 2, kind: 'question', audience: 'requester', authorEmail: 'neville@x.io', authorName: 'Neville', bodyText: 'Which env?', requestGroupId: 'grp-1', createdAt: new Date() },
    ].filter((m) => !where.audience || m.audience === where.audience)));
    signatureMock.getEnabledSignatureForSend.mockResolvedValue({ html: '<p><b>Neville</b> · CISO</p>' });

    const updated = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'Go ahead', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, {});
    expect(updated.status).toBe('approved');
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ conditionNote: AGREED, signatureHtml: '<p><b>Neville</b> · CISO</p>' });
    expect(data.conditionNoteHtml).toBeNull();
    // ticket note names the agreed conditions, and its parts carry them as a list
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.bodyText).toMatch(/APPROVED WITH CONDITIONS ✔ by Neville — "Go ahead" · Agreed conditions: "1\. UAT only/);
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload.parts.conditions).toEqual(ANSWERED.items);
    // decision message — QA 09-18 #1: internal by default, the requester was not on it
    const decision = prismaMock.approvalMessage.create.mock.calls.find((c) => c[0].data.kind === 'decision');
    expect(decision[0].data).toMatchObject({ audience: 'internal', authorEmail: 'neville@x.io', bodyText: `Approved with conditions\nAgreed conditions:\n${AGREED}\nGo ahead` });
    expect(decision[0].data.toEmails).not.toContain('rita@x.io');
    // e-mails: the agent (existing lane) + Vahid (the other approver); the requester only when asked
    let sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'vahid@x.io']);
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload.parts.requesterNotified).toBe(false);

    // ...and with the box ticked the requester is on it, with requester-visible history only
    mailMock.sendTransactionalEmail.mockClear();
    prismaMock.approvalMessage.create.mockClear();
    prismaMock.ticketThreadEntry.create.mockClear();
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ conditions: ANSWERED }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'Go ahead', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, { notifyRequester: true });
    const decision2 = prismaMock.approvalMessage.create.mock.calls.find((c) => c[0].data.kind === 'decision');
    expect(decision2[0].data).toMatchObject({ audience: 'requester' });
    expect(decision2[0].data.toEmails).toContain('rita@x.io');
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload.parts.requesterNotified).toBe(true);
    sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'rita@x.io', 'vahid@x.io']);
    // 23 Sep 2026 (#242611): every decision mail carries the ticket (Reply-To
    // +tp/+fs, threading headers) and the decision note it belongs to, so a
    // reply threads back even when the subject is rewritten.
    for (const s of sends) {
      expect(s.ticket).toEqual(expect.objectContaining({ id: 501 }));
      expect(s).toHaveProperty('threadEntryId');
    }
    const agent = sends.find((s) => s.to === 'req@x.io');
    expect(agent.subject).toMatch(/^Approved with conditions: your approval request/);
    expect(agent.html).toContain('UAT only');
    expect(agent.html).toContain('CISO');
    const rita = sends.find((s) => s.to === 'rita@x.io');
    expect(rita.subject).toBe('Approved with conditions: New laptop [TP-1234]');
    // 26 Oct 2026: the approver's message in the reply format, from them via Ticket Pulse.
    expect(rita.fromName).toBe('Neville via Ticket Pulse');
    expect(rita.html).toContain('<b>Approved with conditions.</b>');
    expect(rita.html).toContain('Earlier in this conversation');
    expect(rita.html).toContain('Which env?');
    expect(rita.html).not.toContain('Budget?'); // internal history never reaches the requester
    expect(rita.html).not.toContain('/tickets/501'); // no app link for the requester
    expect(rita.html).not.toContain('carry on');
    const vahid = sends.find((s) => s.to === 'vahid@x.io');
    expect(vahid.html).toContain('Budget?');
    expect(vahid.html).toContain('Mehdi can carry on with the ticket.');
    expect(vahid.html).toContain('/tickets/501');
    expect(agent.html).toContain('Budget?'); // the agent is an insider
    expect(agent.fromName).toBe('Neville via Ticket Pulse');
  });

  test('a rejection ignores any condition, fans out to the agents, and reaches the requester only when asked', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'No', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, { conditionNote: 'ignored' });
    expect(prismaMock.ticketApproval.update.mock.calls[0][0].data.conditionNote).toBeNull();
    let sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    // QA 09-18 #1: the rejection note stays between the agents by default
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'vahid@x.io']);
    expect(sends.find((s) => s.to === 'rita@x.io')).toBeUndefined();

    mailMock.sendTransactionalEmail.mockClear();
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    await ticketApprovalService.decideInApp(501, 1, 2, 'rejected', 'No', { email: 'neville@x.io', name: 'Neville', role: 'admin' }, null, { notifyRequester: true });
    sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['req@x.io', 'rita@x.io', 'vahid@x.io']);
    expect(sends.find((s) => s.to === 'rita@x.io').subject).toBe('Not approved: New laptop [TP-1234]');
  });

  test('the ticket assignee and whoever escalated the request hear the verdict too (QA 09-18 #1)', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ escalationLog: [{ kind: 'escalated', fromTier: 1, toTier: 2, byEmail: 'agent2@x.io', byName: 'Agent Two', at: new Date().toISOString() }] }));
    const ticketFind = prismaMock.ticket.findUnique.getMockImplementation?.() || null;
    prismaMock.ticket.findUnique.mockImplementation(async (args) => {
      const base = ticketFind ? await ticketFind(args) : (prismaMock.ticket.findUnique.mock.results[0]?.value ?? null);
      if (args?.select?.assignedTech) return { assignedTech: { email: 'tech@x.io', name: 'Tech One' } };
      return base;
    });
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, { email: 'neville@x.io', name: 'Neville', role: 'admin' });
    const sends = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sends.map((s) => s.to).sort()).toEqual(['agent2@x.io', 'req@x.io', 'tech@x.io', 'vahid@x.io']);
    expect(sends.find((s) => s.to === 'tech@x.io').html).toContain('/tickets/501');
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

  test('the approver e-mail no longer repeats the description: it travels in the history below', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-9', subject: 'x', description: '<p>One</p><ul><li>Two</li></ul>' }, decisionUrl: 'https://app/a', noteHtml: '', otherApprovers: [], quoteHtml: '<div>Earlier in this conversation<ul><li>Two</li></ul></div>' });
    expect(html).not.toContain('What the requester wrote');
    expect(html.indexOf('Two')).toBeGreaterThan(html.indexOf('Decide on this request'));
  });

  test('renderApprovalMessageEmail: the question as written, reply-by-mail hint with the web link, Internal line, history appended', () => {
    const html = renderApprovalMessageEmail({
      kind: 'question', authorName: 'Neville', bodyText: 'Budget?', replyUrl: 'https://app/approval-reply/t', canReplyByEmail: true,
      internalNote: true, requesterName: 'Rita Requester', quoteHtml: '<div>Earlier q</div>',
    });
    expect(html).toContain('Budget?');
    expect(html).toContain('https://app/approval-reply/t');
    expect(html).toContain('Just reply to this e-mail to answer');
    expect(html).toContain('Internal: Rita is not on this conversation.');
    expect(html.indexOf('Earlier q')).toBeGreaterThan(html.indexOf('Internal:'));
    const noMail = renderApprovalMessageEmail({ kind: 'question', authorName: 'Rita', bodyText: 'DEV only', replyUrl: 'https://app/r', canReplyByEmail: false });
    expect(noMail).toContain('this mailbox does not read replies');
  });

  test('renderDecisionThreadEmail: verdict first, condition, note, signature; no app link for the requester', () => {
    const html = renderDecisionThreadEmail({
      categoryName: 'Security', ticket: { ref: 'TP-1', subject: 'Laptop', appUrl: null },
      approved: true, approverName: 'Neville', note: 'Go ahead', conditionNote: 'UAT only', signatureHtml: '<p>Neville · CISO</p>',
      recipient: { role: 'requester', name: 'Rita Requester' }, requester: { name: 'Rita Requester' }, requestedByName: 'Mehdi',
    });
    expect(html).toContain('<b>Approved with condition.</b> Your Security request, TP-1.');
    expect(html).toContain('Condition:</span> UAT only');
    expect(html).toContain('Go ahead');
    expect(html).toContain('Neville · CISO');
    expect(html).not.toContain('Open the ticket');
    const rejected = renderDecisionThreadEmail({ ticket: { ref: 'TP-1', subject: 'x', appUrl: 'https://app/t/1' }, approved: false, approverName: 'N', recipient: { role: 'approver', name: 'Vahid' } });
    expect(rejected).toContain('<b>Not approved.</b>');
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

describe('waitingFor — requests I asked about stay on "For you"', () => {
  test('my parked rows only, newest first, with when they were parked', async () => {
    const parkedAt = new Date('2026-10-27T17:00:00Z');
    prismaMock.ticketApproval.findMany.mockResolvedValue([{ ...row({ status: 'info_requested' }), updatedAt: parkedAt, ticket, approvalCategory: SECURITY }]);
    const rows = await ticketApprovalService.waitingFor(1, { email: 'Neville@x.io' });
    const q = prismaMock.ticketApproval.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ workspaceId: 1, status: 'info_requested', approverEmail: 'neville@x.io' });
    expect(q.orderBy).toEqual({ updatedAt: 'desc' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 2, status: 'info_requested', displayRef: 'TP-1234', waitingSince: parkedAt });
    await expect(ticketApprovalService.waitingFor(1, {})).resolves.toEqual([]);
  });
});
