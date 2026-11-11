import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * Unattended requesters are never e-mailed (QA 11-11 audit, after the
 * workflow-engine gap): approval questions and answers, the verdict copy, an
 * agent reply sent through FreshService, and the legacy auto-response.
 * (Harness copied from approvalConditions.test.js.)
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


const { default: conversation, mailable, UNATTENDED_ASK } = await import('../src/services/approvalConversationService.js');
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const TICKET = { id: 77, subject: 'Laptop for alert host', workspaceId: 1, origin: 'ticketpulse', nativeNumber: 77, freshserviceTicketId: null };
const APPROVAL = { id: 9, ticketId: 77, workspaceId: 1, requestGroupId: 'g-9', approverEmail: 'boss@x.io', approverName: 'Boss', requestedBy: 'agent@x.io', status: 'pending', tier: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findUnique.mockResolvedValue({ ...TICKET, requester: { name: 'BST Watchdog', email: 'bst-watchdog@x.io', unattended: true } });
  prismaMock.ticketApproval.findMany.mockResolvedValue([{ id: 9, approverEmail: 'boss@x.io', approverName: 'Boss', tier: 1, status: 'pending' }]);
  prismaMock.approvalReplyToken.create.mockResolvedValue({});
  prismaMock.mailboxConnection.findFirst.mockResolvedValue(null);
  mailMock.deliverTransactionalEmail.mockResolvedValue({ sent: true });
});

describe('approval conversation', () => {
  test('an unattended requester is kept on the request, flagged, and is not mailable', async () => {
    const parts = await conversation.participants(APPROVAL);
    expect(parts.requester).toMatchObject({ role: 'requester', email: 'bst-watchdog@x.io', unattended: true });
    expect(mailable(parts.requester)).toBe(false);
    expect(mailable(parts.agent)).toBe(true);
    expect(prismaMock.ticket.findUnique.mock.calls[0][0].select.requester.select.unattended).toBe(true);
  });

  test('"Ask the requester" is refused with a clear reason, and nothing is stored or sent', async () => {
    await expect(conversation.postMessage(APPROVAL, { kind: 'question', mode: 'requester', bodyText: 'Which host?', author: { email: 'boss@x.io', name: 'Boss' } }))
      .rejects.toThrow(UNATTENDED_ASK);
    expect(prismaMock.approvalMessage.create).not.toHaveBeenCalled();
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a requester-format e-mail drops the unattended requester; a Cc moves up to To', async () => {
    const parts = await conversation.participants(APPROVAL);
    const message = { id: 3, kind: 'question', requestGroupId: 'g-9', bodyText: 'Which host?' };
    await conversation._emailAsReply(APPROVAL, parts, message, { toList: [parts.requester], ccList: [parts.agent], from: parts.approvers[0] });
    expect(mailMock.deliverTransactionalEmail).toHaveBeenCalledTimes(1);
    const sent = mailMock.deliverTransactionalEmail.mock.calls[0][0];
    expect(sent.to).toEqual(['agent@x.io']);
    expect(sent.cc).toEqual([]);
  });

  test('with only the unattended requester addressed, nothing is sent', async () => {
    const parts = await conversation.participants(APPROVAL);
    const out = await conversation._emailAsReply(APPROVAL, parts, { id: 4, kind: 'question', requestGroupId: 'g-9', bodyText: 'x' }, { toList: [parts.requester], ccList: [], from: parts.approvers[0] });
    expect(out).toBeNull();
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });

  test('a one-to-one internal copy is never sent to an unattended person', async () => {
    const parts = await conversation.participants(APPROVAL);
    await conversation._sendInternal(APPROVAL, parts, { id: 5, kind: 'comment', requestGroupId: 'g-9' }, parts.requester, { from: parts.approvers[0] });
    expect(prismaMock.approvalReplyToken.create).not.toHaveBeenCalled();
    expect(mailMock.deliverTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe('other lanes (source guards)', () => {
  test('the verdict copy skips an unattended requester even when ticked', () => {
    expect(src('../src/services/ticketApprovalService.js')).toContain('notifyRequester === true && Boolean(parts.requester) && parts.requester.unattended !== true');
  });

  test('an FS-born reply sent through FreshService is refused for an unattended requester', () => {
    const s = src('../src/services/ticketService.js');
    expect(s).toMatch(/!isNative && !isPrivate && !viaTicketPulse && ticket\.requester\?\.unattended === true/);
    expect(s.indexOf('ticket.requester?.unattended === true')).toBeLessThan(s.indexOf('client.createReply(fsId'));
  });

  test('the legacy auto-response never mails an unattended sender', () => {
    expect(src('../src/services/autoResponseService.js')).toMatch(/if \(!dryRun && !unattendedSender\)/);
  });
});
