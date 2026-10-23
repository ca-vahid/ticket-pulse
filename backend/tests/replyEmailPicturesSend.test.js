import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 23 Oct 2026: a picture pasted into a reply reached the requester as "[Image: pasted-image-1.png]"
 * with the file attached below. The reply e-mail now shows it in place and sends it once.
 */

const findMany = jest.fn();
const prismaMock = {
  ticketThreadEntry: { findMany, count: jest.fn(async () => 0) },
  ticket: { findUnique: jest.fn(async () => null) },
  mailboxConnection: { findMany: jest.fn(async () => []) },
  requester: { findMany: jest.fn(async () => []) },
  ticketAttachment: { findMany: jest.fn(async () => []) },
  notificationDelivery: { create: jest.fn(async () => ({})) },
};
const sendEmail = jest.fn(async () => ({ messageId: '<m@x>', provider: 'sendgrid' }));

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({
  MAX_ATTACHMENT_PAYLOAD_BYTES: 30 * 1024 * 1024, sendEmail, sendAssignmentEmail: jest.fn(), default: { sendEmail, sendAssignmentEmail: jest.fn() },
}));
const picker = { OUTBOUND_MAILBOX_ORDER: [], pickOutboundMailbox: jest.fn(async () => null), pickIngestMailbox: jest.fn(async () => null), setPrimaryMailbox: jest.fn(), sendgridFromAddress: jest.fn(async () => null) };
jest.unstable_mockModule('../src/services/mailboxPicker.js', () => ({ ...picker, default: picker }));
const threading = {
  THREADING_REFERENCE_LIMIT: 10, DEFAULT_MESSAGE_ID_DOMAIN: 'x', normalizeMessageId: (v) => v, domainOfAddress: () => 'x', buildOutboundMessageId: () => '<m@x>',
  threadingHeadersForTicket: jest.fn(async () => ({ inReplyTo: null, references: [] })), plusAddressReplyTo: () => null, storeEntryMessageId: jest.fn(async () => {}),
};
jest.unstable_mockModule('../src/services/emailThreadingService.js', () => ({ ...threading, default: threading }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const png = (width) => {
  const b = Buffer.alloc(4000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  return b;
};

beforeEach(() => {
  sendEmail.mockClear();
  findMany.mockResolvedValue([]);
});

describe('a pasted picture in the reply', () => {
  test('shows in place and goes once, as an inline attachment; other files stay ordinary attachments', async () => {
    const ticket = { id: 10589, workspaceId: 1, origin: 'ticketpulse', subject: 'Request to add a printer', requester: { email: 'requester@example.com' } };
    const entry = {
      id: 900, actorName: 'Sam Tech', actorEmail: 'stech@example.com', occurredAt: new Date(),
      bodyHtml: '<p>You can use the Company Portal app.&nbsp;<i>[Image:&nbsp;pasted-image-1.png]</i></p>', bodyText: 'You can use the Company Portal app. [Image: pasted-image-1.png]',
    };
    const files = [
      { attachment: { id: 31, fileName: 'pasted-image-1.png', contentType: 'image/png' }, buffer: png(900) },
      { attachment: { id: 32, fileName: 'printers.pdf', contentType: 'application/pdf' }, buffer: Buffer.from('%PDF') },
    ];
    const result = await ticketService._emailRequesterReply(ticket, entry, { attachments: files });
    expect(result.sent).toBe(true);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.html).toContain('<img src="cid:tp-pic-1"');
    expect(mail.html).toContain('width="600"');
    expect(mail.html).not.toContain('[Image:');
    expect(mail.attachments).toHaveLength(2);
    expect(mail.attachments.find((a) => a.name === 'pasted-image-1.png').contentId).toBe('tp-pic-1');
    expect(mail.attachments.find((a) => a.name === 'printers.pdf').contentId).toBeUndefined();
  });
});
