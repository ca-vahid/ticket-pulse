import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 22 Nov 2026 review: the Graph lane plus-addressed Reply-To on the mailbox it
 * sent from. A send-only mailbox (mode 'send') is never read, so the requester's
 * answer was lost. Reply-To now rides the mailbox that reads replies, or none —
 * for an agent's reply (ticketService) as for a workflow e-mail (the transport).
 * Invented addresses on example.com only.
 */
const prismaMock = {
  ticketThreadEntry: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0), update: jest.fn(async () => ({})) },
  ticket: { findUnique: jest.fn(async () => null) },
  mailboxConnection: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  requester: { findMany: jest.fn(async () => []) },
  ticketAttachment: { findMany: jest.fn(async () => []) },
  notificationDelivery: { create: jest.fn(async () => ({})) },
};
const sendMailAsMailbox = jest.fn(async () => ({ internetMessageId: '<g@example.com>' }));
const sendEmail = jest.fn(async () => ({ messageId: '<m@example.com>', provider: 'sendgrid' }));
const SEND_ONLY = { id: 5, address: 'ar-out@example.com', mode: 'send', isEnabled: true };
const READER = { id: 6, address: 'ar@example.com', mode: 'ingest', isEnabled: true };
const BOTH = { id: 7, address: 'ap@example.com', mode: 'both', isEnabled: true };
const picker = {
  OUTBOUND_MAILBOX_ORDER: [],
  pickOutboundMailbox: jest.fn(async () => null),
  pickIngestMailbox: jest.fn(async () => null),
  setPrimaryMailbox: jest.fn(),
  sendgridFromAddress: jest.fn(async () => null),
  pickMailboxForTicket: jest.fn(async () => null),
  pickOutboundMailboxForTicket: jest.fn(async () => SEND_ONLY),
  pickIngestMailboxForTicket: jest.fn(async () => READER),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({
  MAX_ATTACHMENT_PAYLOAD_BYTES: 30 * 1024 * 1024, sendEmail, sendAssignmentEmail: jest.fn(), default: { sendEmail, sendAssignmentEmail: jest.fn() },
}));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => true, sendMailAsMailbox, saveSentCopy: jest.fn() } }));
jest.unstable_mockModule('../src/services/mailboxPicker.js', () => ({ ...picker, default: picker }));
jest.unstable_mockModule('../src/services/emailHealthService.js', () => ({ default: { recordSuccess: jest.fn(async () => {}), recordFailure: jest.fn(async () => {}) } }));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({
  resolveFromName: jest.fn(async () => 'Accounting'),
  resolveReplyFromName: jest.fn(async () => 'Eli Park'),
  default: { resolveFromName: jest.fn(async () => 'Accounting'), resolveReplyFromName: jest.fn(async () => 'Eli Park') },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { deliverTransactionalEmail } = await import('../src/services/transactionalEmailService.js');

const ticket = { id: 501, workspaceId: 2, origin: 'ticketpulse', nativeNumber: 1042, groupId: 1002n, subject: 'Invoice question', requester: { email: 'priya.nair@example.com' } };
const entry = { id: 900, actorName: 'Eli Park', actorEmail: 'eli.park@example.com', occurredAt: new Date(), bodyHtml: '<p>Paid today.</p>', bodyText: 'Paid today.' };

beforeEach(() => {
  jest.clearAllMocks();
  picker.pickOutboundMailboxForTicket.mockResolvedValue(SEND_ONLY);
  picker.pickIngestMailboxForTicket.mockResolvedValue(READER);
});

describe('an agent reply (ticketService)', () => {
  test('sent from a send-only mailbox: Reply-To is the mailbox that reads replies', async () => {
    await ticketService._emailRequesterReply(ticket, entry, {});
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar-out@example.com', expect.objectContaining({ replyTo: 'ar+tp1042@example.com' }));
  });

  test('send-only and nothing reads replies: no Reply-To', async () => {
    picker.pickIngestMailboxForTicket.mockResolvedValue(null);
    await ticketService._emailRequesterReply(ticket, entry, {});
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar-out@example.com', expect.objectContaining({ replyTo: null }));
  });

  test('a mailbox that both sends and reads: as before, Reply-To on itself', async () => {
    picker.pickOutboundMailboxForTicket.mockResolvedValue(BOTH);
    await ticketService._emailRequesterReply(ticket, entry, {});
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ap@example.com', expect.objectContaining({ replyTo: 'ap+tp1042@example.com' }));
    expect(picker.pickIngestMailboxForTicket).not.toHaveBeenCalled();
  });
});

describe('a workflow e-mail (transport)', () => {
  const send = () => deliverTransactionalEmail({
    workspaceId: 2, to: 'priya.nair@example.com', subject: 'Received', html: '<p>Thanks</p>', label: 'workflow',
    ticket, mailboxTicket: { workspaceId: 2, groupId: 1002n, internalGroupId: null },
  });

  test('sent from a send-only team mailbox: Reply-To is the team mailbox that reads replies', async () => {
    const result = await send();
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar-out@example.com', expect.objectContaining({ replyTo: 'ar+tp1042@example.com' }));
    expect(result.replyTo).toBe('ar+tp1042@example.com');
  });

  test('send-only and nothing reads replies: no Reply-To', async () => {
    picker.pickIngestMailboxForTicket.mockResolvedValue(null);
    await send();
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar-out@example.com', expect.objectContaining({ replyTo: null }));
  });

  test('no team ticket: the workspace mailbox that reads replies', async () => {
    picker.pickOutboundMailbox.mockResolvedValue(SEND_ONLY);
    picker.pickIngestMailbox.mockResolvedValue(BOTH);
    await deliverTransactionalEmail({ workspaceId: 2, to: 'priya.nair@example.com', subject: 'S', html: '<p>B</p>', ticket });
    expect(sendMailAsMailbox).toHaveBeenCalledWith('ar-out@example.com', expect.objectContaining({ replyTo: 'ap+tp1042@example.com' }));
  });
});
