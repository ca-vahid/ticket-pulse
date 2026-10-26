import { jest } from '@jest/globals';

/**
 * Approve with conditions as a conversation (26 Oct 2026, Vahid): conditions
 * keep the request open; the technician answers each one; the answers go
 * straight back to the approver, who accepts them, changes them or says no.
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
const mailMock = { deliverTransactionalEmail: jest.fn(), sendTransactionalEmail: jest.fn() };
const directoryMock = { resolvePersonName: jest.fn(async (e) => ({ 'rita@x.io': 'Rita Requester', 'req@x.io': 'Mehdi Agent', 'neville@x.io': 'Neville' }[String(e).toLowerCase()] || null)), fillPersonNames: jest.fn(async (rows) => rows) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: activityMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() }, sendEmail: jest.fn() }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: { emitTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/publicTicketStatusService.js', () => ({ getPublicTicketStatusSettings: jest.fn().mockResolvedValue({}), ensurePublicTicketStatusLink: jest.fn() }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/personDirectoryService.js', () => directoryMock);
jest.unstable_mockModule('../src/services/userSignatureService.js', () => ({ getEnabledSignatureForSend: jest.fn().mockResolvedValue(null) }));

const helpers = await import('../src/services/approvalConditions.js');
const { default: conversation } = await import('../src/services/approvalConversationService.js');
const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');
const { renderConditionsEmail, renderApproverRequestEmail } = await import('../src/services/approvalEmailTemplate.js');

const ticket = {
  id: 501, workspaceId: 1, origin: 'ticketpulse', nativeNumber: 1234, subject: 'Claude dashboards', status: 'Open', priority: 2,
  requester: { name: 'Rita Requester', email: 'rita@x.io' }, workspace: { name: 'IT', slug: 'it' },
};
const CATEGORY = { id: 9, workspaceId: 1, name: 'Security', isActive: true, hasAmount: false, managerEmails: ['neville@x.io'], tiers: [{ name: 'Tier 1', managerEmails: ['neville@x.io'], limit: null }] };
const row = (over = {}) => ({
  id: 2, ticketId: 501, workspaceId: 1, status: 'pending', approvalCategoryId: 9, tier: 1, isFinal: false,
  approverEmail: 'neville@x.io', approverName: 'Neville', requestedBy: 'req@x.io', requestGroupId: 'grp-1',
  requestNote: 'Please approve', requestNoteHtml: null, amount: null, amountCurrency: null, escalationLog: null, clarificationLog: [],
  conditions: null, expiresAt: new Date(Date.now() + 86400000), ...over,
});
const OPEN = {
  round: 1, setBy: 'neville@x.io', setByName: 'Neville', setAt: '2026-10-26T16:00:00.000Z', note: null,
  items: [
    { id: 1, text: 'Only Public or Internal data', response: null, answer: null },
    { id: 2, text: 'Scope limited to named workspaces', response: null, answer: null },
  ],
  submittedAt: null, submittedBy: null, submittedByName: null,
};
const actor = { email: 'neville@x.io', name: 'Neville' };
const it = { email: 'req@x.io', name: 'Mehdi Agent' };

let msgSeq = 600;
beforeEach(() => {
  jest.clearAllMocks();
  msgSeq = 600;
  activityMock.create.mockResolvedValue({});
  prismaMock.ticket.findFirst.mockResolvedValue(ticket);
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.approvalCategory.findFirst.mockResolvedValue(CATEGORY);
  prismaMock.approvalCategory.findUnique.mockResolvedValue(CATEGORY);
  prismaMock.mailboxConnection.findFirst.mockResolvedValue({ id: 3, address: 'ticketpulse@x.io', mode: 'ingest', isEnabled: true });
  prismaMock.ticketThreadEntry.create.mockResolvedValue({ id: 9 });
  prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
  prismaMock.ticketApproval.findMany.mockResolvedValue([{ id: 2, approverEmail: 'neville@x.io', approverName: 'Neville', tier: 1, status: 'pending' }]);
  prismaMock.ticketApproval.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.ticketApproval.update.mockImplementation(({ where, data }) => Promise.resolve({ ...row(), id: where.id, ...data }));
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.workspaceAccess.findMany.mockResolvedValue([]);
  prismaMock.requester.findFirst.mockResolvedValue(null);
  prismaMock.approvalMessage.create.mockImplementation(({ data }) => Promise.resolve({ id: ++msgSeq, createdAt: new Date(), ...data }));
  prismaMock.approvalMessage.findMany.mockResolvedValue([]);
  prismaMock.approvalMessage.update.mockResolvedValue({});
  prismaMock.approvalReplyToken.create.mockImplementation(({ data }) => Promise.resolve({ id: 77, ...data }));
  prismaMock.approvalReplyToken.update.mockResolvedValue({});
  mailMock.deliverTransactionalEmail.mockResolvedValue({ sent: true });
  mailMock.sendTransactionalEmail.mockResolvedValue({ sent: true });
});

describe('helpers', () => {
  test('a pasted paragraph with bullets becomes one condition per bullet; the lead-in stays a note', () => {
    const text = 'This approval is based on Claude building dashboards. Please confirm the below -\n- Which workspaces are in scope?\n- Only Public/Internal data.\n  Sensitivity labels on each model.\n1) Licensed Claude only';
    expect(helpers.splitConditionText(text)).toEqual({
      lead: 'This approval is based on Claude building dashboards. Please confirm the below -',
      items: ['Which workspaces are in scope?', 'Only Public/Internal data. Sensitivity labels on each model.', 'Licensed Claude only'],
    });
    expect(helpers.splitConditions('UAT only')).toEqual(['UAT only']);
  });

  test('a marker on its own line takes the text below it; a paragraph after the list is its own condition', () => {
    const text = 'Could someone please confirm the below\n\n-\nWhich workspaces are in scope?\n\n-\nOnly Public/Internal data.\n\nAdditionally, look at the local folder method.';
    expect(helpers.splitConditionText(text)).toEqual({
      lead: 'Could someone please confirm the below',
      items: ['Which workspaces are in scope?', 'Only Public/Internal data.', 'Additionally, look at the local folder method.'],
    });
  });

  test('an open request with no conditions starts from the newest earlier row that had one', () => {
    const rows = [
      { id: 172, status: 'pending', conditions: null, conditionNote: null },
      { id: 169, status: 'escalated', conditionNote: null },
      { id: 166, status: 'approved', approverName: 'Dana', decidedAt: '2026-10-24T00:03:38.937Z', conditionNote: 'Please confirm\n- A\n- B' },
      { id: 100, status: 'approved', conditionNote: '- Old' },
    ];
    expect(helpers.earlierConditionsFor(rows[0], rows)).toEqual({ approvalId: 166, items: ['A', 'B'], lead: 'Please confirm', setByName: 'Dana', setByEmail: null, setAt: '2026-10-24T00:03:38.937Z' });
    // Its own list wins, and decided rows get nothing.
    expect(helpers.earlierConditionsFor({ ...rows[0], conditions: { items: [{ id: 1, text: 'X' }] } }, rows)).toBeNull();
    expect(helpers.earlierConditionsFor(rows[2], rows)).toBeNull();
  });

  test('unchanged conditions keep their answers; duplicates and blanks are dropped', () => {
    const prior = { items: [{ id: 1, text: 'A', response: 'can_meet', answer: 'yes' }] };
    const items = helpers.conditionItems(['a ', 'B', '', 'B'], null, prior);
    expect(items).toEqual([
      { id: 1, text: 'a', response: 'can_meet', answer: 'yes' },
      { id: 2, text: 'B', response: null, answer: null, answeredBy: null, answeredByName: null, answeredAt: null },
    ]);
    expect(helpers.sameConditions(prior.items, [{ text: 'a' }])).toBe(true);
  });

  test("an answer counts once it says can or can't — and a can't needs a reason", () => {
    expect(helpers.isAnswered({ response: 'can_meet' })).toBe(true);
    expect(helpers.isAnswered({ response: 'cant_meet', answer: '  ' })).toBe(false);
    expect(helpers.isAnswered({ response: 'cant_meet', answer: 'The endpoint reaches every model' })).toBe(true);
    expect(helpers.agreedSummary({ items: [{ text: 'X', response: 'cant_meet', answer: 'No' }, { text: 'Y' }] }))
      .toBe("1. X\n   Can't be met as asked: No\n2. Y\n   Not answered.");
  });
});

describe('approving with conditions', () => {
  test('keeps the request open with IT: info_requested, the items stored, a note and an e-mail to the technician — no verdict', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    const updated = await ticketApprovalService.decideInApp(501, 1, 2, 'approved', 'Security first', actor, null, { conditions: ['Only Public or Internal data', 'Scope limited to named workspaces'] });
    expect(updated.status).toBe('info_requested');
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data.status).toBe('info_requested');
    expect(data.conditions).toMatchObject({ round: 1, setBy: 'neville@x.io', note: 'Security first', submittedAt: null });
    expect(data.conditions.items.map((i) => i.text)).toEqual(['Only Public or Internal data', 'Scope limited to named workspaces']);
    expect(data.decidedAt).toBeUndefined();
    // no siblings superseded, no verdict e-mails
    expect(prismaMock.ticketApproval.updateMany).not.toHaveBeenCalled();
    expect(mailMock.sendTransactionalEmail).not.toHaveBeenCalled();
    // the technician hears it
    const sent = mailMock.deliverTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['req@x.io'], label: 'approval conditions' });
    expect(sent[0].html).toContain('not approved yet');
    expect(sent[0].html).toContain('Scope limited to named workspaces');
    // an internal message + a ticket note
    expect(prismaMock.approvalMessage.create.mock.calls[0][0].data).toMatchObject({ kind: 'comment', audience: 'internal', toEmails: ['req@x.io'] });
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload).toMatchObject({ kind: 'approval_event', event: 'conditions' });
  });

  test('an older client sending one block of text gets it split into conditions', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row());
    const spy = jest.spyOn(ticketApprovalService, '_findByToken').mockResolvedValue(row());
    await ticketApprovalService.decideByToken('tok', 'approved', null, null, { conditionNote: 'Approved if:\n- A\n- B' });
    spy.mockRestore();
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data.conditions.items.map((i) => i.text)).toEqual(['A', 'B']);
    expect(data.conditions.note).toBe('Approved if:');
  });

  test('changing the conditions starts round 2; an unchanged one keeps its answer', async () => {
    const answered = { ...OPEN, items: [{ ...OPEN.items[0], response: 'can_meet', answer: 'Labelled' }, { ...OPEN.items[1], response: 'cant_meet', answer: 'Not possible' }], submittedAt: '2026-10-26T17:00:00Z', submittedByName: 'Mehdi Agent' };
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ conditions: answered }));
    await ticketApprovalService.decideInApp(501, 1, 2, 'approved', null, actor, null, { conditions: ['Only Public or Internal data', 'Pilot users only'] });
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data.status).toBe('info_requested');
    expect(data.conditions.round).toBe(2);
    expect(data.conditions.items[0]).toMatchObject({ text: 'Only Public or Internal data', response: 'can_meet', answer: 'Labelled' });
    expect(data.conditions.items[1]).toMatchObject({ text: 'Pilot users only', response: null });
    expect(mailMock.deliverTransactionalEmail.mock.calls[0][0].html).toContain('changed the conditions');
  });

  test('the generic resubmit is refused while conditions wait on IT', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'info_requested', conditions: OPEN }));
    await expect(ticketApprovalService.resubmit(501, 1, 2, it)).rejects.toThrow(/Answer each condition/);
  });
});

describe('IT answers the conditions', () => {
  beforeEach(() => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'info_requested', conditions: OPEN }));
  });

  test('a draft saves the answers and changes nothing else', async () => {
    await ticketApprovalService.answerConditions(501, 1, 2, { answers: [{ id: 1, response: 'can_meet', answer: 'Labelled' }] }, it);
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(['conditions']);
    expect(data.conditions.items[0]).toMatchObject({ response: 'can_meet', answer: 'Labelled', answeredBy: 'req@x.io' });
    expect(mailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  });

  test("sending needs every condition answered, and a reason for each one that can't be met", async () => {
    await expect(ticketApprovalService.answerConditions(501, 1, 2, { answers: [{ id: 1, response: 'can_meet' }], submit: true }, it)).rejects.toThrow(/1 still needs an answer/);
    await expect(ticketApprovalService.answerConditions(501, 1, 2, { answers: [{ id: 1, response: 'can_meet' }, { id: 2, response: 'cant_meet', answer: '' }], submit: true }, it)).rejects.toThrow(/still needs/);
    expect(prismaMock.ticketApproval.update).not.toHaveBeenCalled();
  });

  test('the approver cannot answer their own conditions', async () => {
    await expect(ticketApprovalService.answerConditions(501, 1, 2, { answers: [] }, actor)).rejects.toThrow(/technician answers them/);
  });

  test('sending puts the request back with the approver: pending, a fresh link, and an e-mail with each answer', async () => {
    await ticketApprovalService.answerConditions(501, 1, 2, {
      answers: [{ id: 1, response: 'can_meet', answer: 'Models carry labels' }, { id: 2, response: 'cant_meet', answer: 'The endpoint reaches every model the user can see' }],
      submit: true,
    }, it);
    const data = prismaMock.ticketApproval.update.mock.calls[0][0].data;
    expect(data.status).toBe('pending');
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.conditions).toMatchObject({ submittedBy: 'req@x.io', submittedByName: 'Mehdi Agent' });
    const mail = mailMock.sendTransactionalEmail.mock.calls.find((c) => c[0].label === 'approval');
    expect(mail[0].to).toBe('neville@x.io');
    expect(mail[0].html).toContain('The answers to your conditions are in');
    expect(mail[0].html).toContain("Can&#39;t be met as asked");
    expect(mail[0].html).toContain('The endpoint reaches every model the user can see');
    expect(mail[0].html).toContain('>Not approved<');
    expect(prismaMock.approvalMessage.create.mock.calls[0][0].data).toMatchObject({ kind: 'answer', audience: 'internal', toEmails: ['neville@x.io'] });
    expect(prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload).toMatchObject({ event: 'condition_answers' });
    // and it cannot be sent twice
    prismaMock.ticketApproval.findFirst.mockResolvedValue(row({ status: 'pending', conditions: data.conditions }));
    await expect(ticketApprovalService.answerConditions(501, 1, 2, { answers: [], submit: true }, it)).rejects.toThrow(/already sent back/);
  });
});

describe('looping in the requester while IT answers', () => {
  test("the requester's answer helps the technician; the request stays with IT and the approver is not re-asked", async () => {
    const question = { id: 701, kind: 'question', audience: 'requester', requestGroupId: 'grp-1', authorEmail: 'req@x.io', authorName: 'Mehdi Agent', bodyText: 'Which models?', createdAt: new Date(), toEmails: ['rita@x.io'], ccEmails: [] };
    prismaMock.approvalReplyToken.findUnique.mockResolvedValue({ id: 77, messageId: 701, recipientEmail: 'rita@x.io', requestGroupId: 'grp-1', expiresAt: new Date(Date.now() + 86400000) });
    prismaMock.approvalMessage.findUnique.mockResolvedValue(question);
    const parked = row({ status: 'info_requested', conditions: OPEN });
    prismaMock.ticketApproval.findFirst.mockResolvedValue(parked);
    prismaMock.ticketApproval.findMany.mockImplementation(({ where }) => Promise.resolve(where.status ? [parked] : [{ id: 2, approverEmail: 'neville@x.io', approverName: 'Neville', tier: 1, status: 'info_requested' }]));
    await conversation.answer({ token: 'tok', bodyText: 'Finance models only', via: 'link' });
    expect(prismaMock.ticketApproval.update).not.toHaveBeenCalled();
    expect(mailMock.sendTransactionalEmail).not.toHaveBeenCalled();
    const told = mailMock.deliverTransactionalEmail.mock.calls.map((c) => c[0]);
    expect(told.map((m) => m.to)).toEqual([['req@x.io']]);
  });
});

describe('e-mails', () => {
  test('the technician e-mail lists the conditions and says nothing is approved yet', () => {
    const html = renderConditionsEmail({ approverName: 'Neville', technicianName: 'Mehdi', categoryName: 'Security', ticket: { ref: 'TP-1', subject: 'Dashboards', appUrl: 'https://tp/tickets/1' }, items: OPEN.items, note: 'Security first' });
    expect(html).toContain('Approved with conditions — your answers needed');
    expect(html).toContain('<b>not approved yet</b>');
    expect(html).toContain('Only Public or Internal data');
    expect(html).toContain('Answer on the ticket');
    expect(html).toContain('Security first');
  });

  test('a first request keeps Approve / Not approved / Ask', () => {
    const html = renderApproverRequestEmail({ ticket: { ref: 'TP-1', subject: 'X' }, decisionUrl: 'https://tp/approval/t', requester: {} });
    expect(html).toContain('>Not approved<');
    expect(html).not.toContain('>Decline<');
  });
});
