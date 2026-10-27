import { jest } from '@jest/globals';

/**
 * Watcher e-mails in the reply format (26 Oct 2026): the requester's own
 * words, one grey line naming what you watch with the ticket link, and for a
 * reply the conversation so far — sent as "<requester> via Ticket Pulse",
 * one e-mail per watcher, threaded under the ticket.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn() },
  ticketWatchSubscription: { findMany: jest.fn() },
  ticketThreadEntry: { findUnique: jest.fn() },
  group: { findFirst: jest.fn() },
};
const mailMock = { sendTransactionalEmail: jest.fn().mockResolvedValue({ sent: true }) };
const quoteMock = { _lastInboundQuote: jest.fn().mockResolvedValue({ html: '<div>Earlier in this conversation</div>', text: '\n\nOn …' }) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: quoteMock }));
jest.unstable_mockModule('../src/services/replyEmailPictures.js', () => ({
  createInlineBudget: () => ({ inline: [] }),
  inlinePictures: async (html) => html,
  inlineAttachments: () => [],
}));
jest.unstable_mockModule('../src/services/workspaceEmailIdentityService.js', () => ({ resolveFromName: jest.fn().mockResolvedValue('IT Service Desk') }));

const { default: watcher, renderWatcherEmail } = await import('../src/services/watcherNotificationService.js');

const ticket = {
  id: 7, workspaceId: 1, subject: 'Printer jam', origin: 'ticketpulse', nativeNumber: 42, freshserviceTicketId: null,
  internalCategoryId: 3, internalSubcategoryId: 4, groupId: 900n,
  description: '<p>The 3rd floor printer is <b>jammed</b>.</p>', descriptionText: null,
  internalCategory: { name: 'Hardware' }, internalSubcategory: { name: 'Printers' },
  requester: { name: 'Rita Requester', email: 'rita@x.io' },
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PUBLIC_APP_URL = 'https://tp.x.io';
  prismaMock.ticket.findUnique.mockResolvedValue(ticket);
  prismaMock.group.findFirst.mockResolvedValue({ name: 'Service Desk' });
  prismaMock.ticketWatchSubscription.findMany.mockResolvedValue([
    { userEmail: 'pat@x.io', scopeType: 'category', categoryId: 4 },
    { userEmail: 'lee@x.io', scopeType: 'group', groupId: 900n },
    { userEmail: 'rita@x.io', scopeType: 'category', categoryId: 3 }, // the requester never gets their own ticket
  ]);
});

test('a new ticket: the description as the message, one per watcher, from the requester via Ticket Pulse', async () => {
  const res = await watcher.notify('created', 7);
  expect(res.sent).toBe(2);
  const mails = mailMock.sendTransactionalEmail.mock.calls.map((c) => c[0]);
  expect(mails.map((m) => m.to)).toEqual([['pat@x.io'], ['lee@x.io']]);
  for (const m of mails) {
    expect(m.fromName).toBe('Rita Requester via Ticket Pulse');
    expect(m.subject).toBe('[watching] New ticket TP-42: Printer jam');
    expect(m.ticket).toEqual(expect.objectContaining({ id: 7 }));
    expect(m.html).toContain('<b>jammed</b>');
    expect(m.html).toContain('Rita opened TP-42.');
    expect(m.html).toContain('href="https://tp.x.io/tickets/');
    expect(m.html).not.toMatch(/background(-color)?:/);
  }
  expect(mails[0].html).toContain('You watch Hardware › Printers.');
  expect(mails[1].html).toContain('You watch the Service Desk group.');
  expect(quoteMock._lastInboundQuote).not.toHaveBeenCalled();
});

test('a requester reply: their words as written, the history below, the entry left out of it', async () => {
  prismaMock.ticketWatchSubscription.findMany.mockResolvedValue([{ userEmail: 'pat@x.io', scopeType: 'category', categoryId: 3 }]);
  prismaMock.ticketThreadEntry.findUnique.mockResolvedValue({ id: 55, bodyHtml: '<p>Still jammed, sorry!</p>', bodyText: 'Still jammed, sorry!', actorName: 'Rita Requester', actorEmail: 'rita@x.io', occurredAt: new Date() });
  await watcher.notify('requester_reply', 7, { entryPreview: 'Still jammed, sorry!', entryId: 55 });
  const mail = mailMock.sendTransactionalEmail.mock.calls[0][0];
  expect(mail.html).toContain('Still jammed, sorry!');
  expect(mail.html).toContain('Rita replied on TP-42. You watch Hardware.');
  expect(mail.html.indexOf('Earlier in this conversation')).toBeGreaterThan(mail.html.indexOf('You watch'));
  expect(quoteMock._lastInboundQuote).toHaveBeenCalledWith(7, 55, expect.objectContaining({ reply: expect.objectContaining({ text: 'Still jammed, sorry!' }) }));
});

test('renderWatcherEmail escapes and degrades', () => {
  const html = renderWatcherEmail({ eventKind: 'created', ref: 'TP-1', appUrl: null, requesterName: '<b>x</b>', bodyHtml: '' });
  expect(html).toContain('&lt;b&gt;x&lt;/b&gt; opened TP-1. You watch this category or group.');
  expect(html).toContain('(no message)');
  expect(html).not.toContain('href=');
});
