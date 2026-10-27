import { jest } from '@jest/globals';

/**
 * The shared plumbing of the reply-format approval e-mails (26 Oct 2026):
 * the history keeps to the audience, the plain-text twin keeps link
 * addresses, the subject threads.
 */
const prismaMock = { approvalMessage: { findMany: jest.fn() } };
const quoteMock = { _lastInboundQuote: jest.fn() };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: quoteMock }));
jest.unstable_mockModule('../src/services/replyEmailPictures.js', () => ({
  createInlineBudget: () => ({ inline: [{ name: 'f.png', contentType: 'image/png', contentBytes: 'AA', contentId: 'tp-face-1' }] }),
  inlineAttachments: (b) => b.inline,
}));

const { approvalHistory, requestNoteEntry, plainTextOf, replySubject, viaTicketPulse } = await import('../src/services/approvalReplyMail.js');

const rows = [
  { id: 1, kind: 'question', audience: 'internal', authorName: 'Pat', authorEmail: 'pat@x.io', bodyText: 'Budget?', createdAt: new Date('2026-10-20T10:00:00Z') },
  { id: 2, kind: 'question', audience: 'requester', authorName: 'Pat', authorEmail: 'pat@x.io', bodyText: 'Which env?', createdAt: new Date('2026-10-20T11:00:00Z') },
  { id: 3, kind: 'decision', audience: 'internal', authorName: 'Pat', authorEmail: 'pat@x.io', bodyText: 'Approved', createdAt: new Date('2026-10-20T12:00:00Z') },
  { id: 4, kind: 'handoff', audience: 'internal', authorName: 'Pat', authorEmail: 'pat@x.io', bodyText: 'Escalated', createdAt: new Date('2026-10-20T13:00:00Z') },
];

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.approvalMessage.findMany.mockImplementation(({ where }) => Promise.resolve(rows.filter((r) => !where.audience || r.audience === where.audience)));
  quoteMock._lastInboundQuote.mockResolvedValue({ html: '<div>history</div>', text: '\n\nOn …' });
});

test('requester audience: only requester-audience questions/answers/comments reach the history', async () => {
  const out = await approvalHistory({ ticketId: 7, requestGroupId: 'g', audience: 'requester' });
  expect(prismaMock.approvalMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { requestGroupId: 'g', audience: 'requester' } }));
  const extra = quoteMock._lastInboundQuote.mock.calls[0][2].extra;
  expect(extra.map((e) => e.bodyText)).toEqual(['Which env?']);
  expect(out).toEqual({ html: '<div>history</div>', text: '\n\nOn …', attachments: [expect.objectContaining({ contentId: 'tp-face-1' })] });
});

test('internal audience: every message but hand-offs, minus what skip() drops, plus the request note', async () => {
  const approval = { requestNote: 'Please approve', requestNoteHtml: null, requestedBy: 'Mia@x.io', createdAt: new Date('2026-10-19T09:00:00Z') };
  await approvalHistory({ ticketId: 7, requestGroupId: 'g', audience: 'internal', skip: (m) => m.kind === 'decision', requestNote: requestNoteEntry(approval, 'Mia Agent') });
  const extra = quoteMock._lastInboundQuote.mock.calls[0][2].extra;
  expect(extra.map((e) => e.bodyText)).toEqual(['Budget?', 'Which env?', 'Please approve']);
  expect(extra[2]).toMatchObject({ actorName: 'Mia Agent', actorEmail: 'mia@x.io' });
});

test('never throws: a failing quote costs the history only', async () => {
  quoteMock._lastInboundQuote.mockRejectedValue(new Error('db down'));
  await expect(approvalHistory({ ticketId: 7, requestGroupId: 'g' })).resolves.toEqual({ html: '', text: '', attachments: [] });
  await expect(approvalHistory({})).resolves.toEqual({ html: '', text: '', attachments: [] });
});

test('plain-text twin, subject and sender name', () => {
  expect(plainTextOf('<p>Hi,</p><p><a href="https://x.io/a?b=1&amp;c=2">Decide on this request&nbsp;&rarr;</a></p>')).toBe('Hi,\nDecide on this request <https://x.io/a?b=1&c=2>');
  expect(replySubject('RE: Laptop\nswap', 'TP-9')).toBe('Re: Laptop swap [TP-9]');
  expect(viaTicketPulse('Pat Approver')).toBe('Pat Approver via Ticket Pulse');
  expect(viaTicketPulse('', null)).toBeNull();
});
