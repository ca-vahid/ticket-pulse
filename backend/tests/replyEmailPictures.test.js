import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Vahid, 23 Oct 2026, looking at a reply thread in Outlook: the signature logo in the quoted
 * history and the screenshot pasted into the reply both came through as "[Image: …]" text, the
 * quoted avatars were initials, and the tech's own quoted reply had lost its signature.
 *
 * - every "[Image: name]" the e-mail can afford becomes the picture, carried inside it (cid:);
 * - the reply's own pasted picture goes once, inline — not again as an attachment;
 * - the quoted history has one heading, Outlook-style From / Sent / Cc lines and Entra photos;
 * - a quoted reply of ours is signed as it was sent (sentSignature), older ones with today's.
 */

const findMany = jest.fn();
const count = jest.fn();
const findUnique = jest.fn();
const mailboxes = jest.fn();
const requesters = jest.fn();
const attachments = jest.fn();
const signatureRow = jest.fn();
const prismaMock = {
  ticketThreadEntry: { findMany, count },
  ticket: { findUnique },
  mailboxConnection: { findMany: mailboxes },
  requester: { findMany: requesters },
  ticketAttachment: { findMany: attachments },
  userEmailSignature: { findUnique: signatureRow },
};
const bufferFor = jest.fn();
const inlinePhotoAttachment = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({
  default: { bufferFor, isConfigured: () => true, upload: jest.fn(), listForTicket: jest.fn() },
}));
jest.unstable_mockModule('../src/services/userPhotoService.js', () => ({
  getCachedUserPhoto: jest.fn(async () => null),
  decodePhotoDataUri: jest.fn(() => null),
  resetUserPhotoCache: jest.fn(),
  inlinePhotoAttachment,
  default: { inlinePhotoAttachment },
}));

const pictures = await import('../src/services/replyEmailPictures.js');
const { default: ticketService } = await import('../src/services/ticketService.js');

// A PNG header saying 1600 px wide (bytes 16-19), padded.
const png = (width = 1600, size = 2000) => {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(width, 16);
  return b;
};
const file = (over = {}) => ({
  id: 1, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 2000, blobName: 'b',
  source: 'upload', threadEntryId: null, createdAt: new Date('2026-10-22T23:00:00Z'), ...over,
});
const entry = (over = {}) => ({
  id: 50, source: 'email_inbound', bodyHtml: null, bodyText: 'Can we please assign Alex a licence for the new tool?', content: null,
  actorName: 'Pat Example', actorEmail: 'pexample@example.com',
  occurredAt: new Date('2026-10-22T23:15:00Z'),
  isPrivate: false, eventType: 'reply', rawPayload: null, ...over,
});
const ticketRow = (over = {}) => ({
  description: null, descriptionText: null, createdAt: new Date('2026-10-22T23:15:00Z'),
  ccEmails: [], workspaceId: 1,
  requester: { name: 'Pat Example', email: 'pexample@example.com' },
  workspace: { defaultTimezone: 'America/Vancouver' }, ...over,
});

beforeEach(() => {
  for (const fn of [findMany, count, findUnique, mailboxes, requesters, attachments, signatureRow, bufferFor, inlinePhotoAttachment]) fn.mockReset();
  count.mockResolvedValue(1);
  findMany.mockResolvedValue([]);
  mailboxes.mockResolvedValue([]);
  requesters.mockResolvedValue([]);
  attachments.mockResolvedValue([]);
  signatureRow.mockResolvedValue(null);
  inlinePhotoAttachment.mockResolvedValue(null);
  findUnique.mockResolvedValue(ticketRow());
});

describe('which file a marker means', () => {
  test('the copy kept with the message wins over a newer one of the same name', () => {
    const files = [file({ id: 1, threadEntryId: 7 }), file({ id: 2, threadEntryId: 9 })];
    expect(pictures.pickPicture(files, 'pasted-image-1.png', { entryId: 7 }).id).toBe(1);
  });

  test('otherwise the newest copy stored by the time the message was written', () => {
    const files = [
      file({ id: 1, createdAt: new Date('2026-10-22T10:00:00Z') }),
      file({ id: 2, createdAt: new Date('2026-10-22T12:00:00Z') }),
      file({ id: 3, createdAt: new Date('2026-10-22T18:00:00Z') }),
    ];
    expect(pictures.pickPicture(files, 'pasted-image-1.png', { at: new Date('2026-10-22T13:00:00Z') }).id).toBe(2);
    expect(pictures.pickPicture(files, 'other.png', {})).toBeNull();
  });
});

describe('pictures in the body', () => {
  test("the reply's own pasted picture goes once, inline, at most 600 px wide", async () => {
    const budget = pictures.createInlineBudget();
    const own = [{ attachment: { id: 31, fileName: 'pasted-image-1.png' }, buffer: png(1600) }];
    const html = await pictures.inlinePictures('<p>Use Company Portal.&nbsp;<i>[Image:&nbsp;pasted-image-1.png]</i></p>', { budget, ticketId: 1, own });
    expect(html).toContain('<img src="cid:tp-pic-1"');
    expect(html).toContain('width="600"');
    expect(html).not.toContain('[Image:');
    expect(budget.reused.get(31)).toBe('tp-pic-1');
    expect(pictures.inlineAttachments(budget)).toEqual([]);
    expect(attachments).not.toHaveBeenCalled();
  });

  test("a picture stored on the ticket is fetched and carried inside the mail", async () => {
    attachments.mockResolvedValue([file({ id: 8, fileName: 'picture-1-AbCdEf-image.png', threadEntryId: 50 })]);
    bufferFor.mockResolvedValue(png(240));
    const budget = pictures.createInlineBudget();
    const html = await pictures.inlinePictures('<p><em>[Image: picture-1-AbCdEf-image.png]</em></p>', { budget, ticketId: 1, entryId: 50, maxWidth: 480 });
    expect(html).toContain('<img src="cid:tp-pic-1"');
    expect(html).toContain('width="240"');
    expect(pictures.inlineAttachments(budget)).toEqual([
      expect.objectContaining({ name: 'picture-1-AbCdEf-image.png', contentType: 'image/png', contentId: 'tp-pic-1' }),
    ]);
  });

  test('over the budget, or with no file, the marker stays as text', async () => {
    attachments.mockResolvedValue([file({ id: 8, fileName: 'big.png', sizeBytes: 5 * 1024 * 1024 })]);
    const budget = pictures.createInlineBudget();
    const html = await pictures.inlinePictures('<p>[Image: big.png] [Image: gone.png]</p>', { budget, ticketId: 1 });
    expect(html).toBe('<p>[Image: big.png] [Image: gone.png]</p>');
    expect(bufferFor).not.toHaveBeenCalled();
  });

  test('without a budget nothing changes (the quote can be built on its own)', async () => {
    expect(await pictures.inlinePictures('<p>[Image: a.png]</p>', {})).toBe('<p>[Image: a.png]</p>');
  });
});

describe('photos', () => {
  test("one photo per person, at Entra's small size; none → initials", async () => {
    inlinePhotoAttachment.mockImplementation(async (email, cid) => (email === 'snasiri@example.com'
      ? { name: `${cid}.jpg`, contentType: 'image/jpeg', contentBytes: Buffer.alloc(3000).toString('base64'), contentId: cid, inline: true }
      : null));
    const budget = pictures.createInlineBudget();
    expect(await pictures.faceFor(budget, 'SNasiri@example.com')).toBe('tp-face-1');
    expect(await pictures.faceFor(budget, 'snasiri@example.com')).toBe('tp-face-1');
    expect(await pictures.faceFor(budget, 'nobody@example.com')).toBeNull();
    expect(inlinePhotoAttachment).toHaveBeenCalledTimes(2);
    expect(inlinePhotoAttachment).toHaveBeenCalledWith('snasiri@example.com', 'tp-face-1', { size: '96x96' });
    expect(pictures.inlineAttachments(budget)).toHaveLength(1);
  });
});

describe('the quoted history', () => {
  test('one heading for the whole history, From / Sent / Cc per message', async () => {
    findMany.mockResolvedValue([
      entry({ id: 51, source: 'ticketpulse_user', actorName: 'Sam Tech', actorEmail: 'stech@example.com', occurredAt: new Date('2026-10-22T23:33:00Z'), bodyText: 'We can assign Alex a licence, but she would lose the other one.' }),
      entry({ id: 50 }),
    ]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html.match(/Earlier in this conversation/g)).toHaveLength(1);
    expect(quote.html).toContain('Earlier in this conversation &middot; 2 messages');
    expect(quote.html).toContain('From:</span> <span style="font-weight:600;color:#0f172a;">Sam Tech</span> &lt;stech@example.com&gt;');
    expect(quote.html).toContain('Sent:</span> Thu 22 Oct 2026, 4:33 PM');
    expect(quote.html).toContain('class="gmail_quote"');
    expect(quote.text).toContain('Sam Tech wrote:');
  });

  test("with a budget, the sender's photo replaces the initials and the logo in their mail shows", async () => {
    inlinePhotoAttachment.mockImplementation(async (email, cid) => ({ name: `${cid}.jpg`, contentType: 'image/jpeg', contentBytes: 'AAAA', contentId: cid, inline: true }));
    attachments.mockResolvedValue([file({ id: 8, fileName: 'picture-1-AbCdEf-image.png', threadEntryId: 50 })]);
    bufferFor.mockResolvedValue(png(300));
    findMany.mockResolvedValue([entry({ bodyHtml: '<p>Pat</p><p><em>[Image: picture-1-AbCdEf-image.png]</em></p>' })]);
    const budget = pictures.createInlineBudget();
    const quote = await ticketService._lastInboundQuote(1, null, { budget });
    expect(quote.html).toContain('<img src="cid:tp-face-1" width="36" height="36"');
    expect(quote.html).toContain('<img src="cid:tp-pic-1"');
    expect(quote.html).not.toContain('[Image:');
    expect(quote.text).not.toContain('cid:');
    expect(pictures.inlineAttachments(budget).map((a) => a.contentId).sort()).toEqual(['tp-face-1', 'tp-pic-1']);
  });

  test('our quoted reply carries the signature it was sent with', async () => {
    findMany.mockResolvedValue([entry({
      id: 51, source: 'ticketpulse_user', actorName: 'Sam Tech', actorEmail: 'stech@example.com',
      bodyHtml: '<p>Kind regards,</p>', bodyText: 'Kind regards,',
      rawPayload: { sentSignature: { html: '<p><b>Sam Tech</b><br>Junior IT Technician</p>', text: 'Sam Tech\nJunior IT Technician' } },
    })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('Junior IT Technician');
    expect(signatureRow).not.toHaveBeenCalled();
  });

  test("a reply from before 4.2.70 gets the agent's signature as it is today", async () => {
    signatureRow.mockResolvedValue({ enabled: true, html: '<p>Sam Tech · IT</p>', text: 'Sam Tech · IT', spacing: null });
    findMany.mockResolvedValue([entry({
      id: 51, source: 'ticketpulse_user', actorName: 'Sam Tech', actorEmail: 'stech@example.com',
      occurredAt: new Date('2026-10-01T18:00:00Z'), bodyHtml: '<p>Done, thanks.</p>', bodyText: 'Done, thanks.',
    })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('Sam Tech · IT');
  });

  test('a later reply sent unsigned stays unsigned (an Auto-help answer carries its own)', async () => {
    signatureRow.mockResolvedValue({ enabled: true, html: '<p>Sam Tech · IT</p>', text: 'Sam Tech · IT', spacing: null });
    findMany.mockResolvedValue([entry({
      id: 51, source: 'ticketpulse_user', actorName: 'Sam Tech', actorEmail: 'stech@example.com',
      bodyHtml: '<p>Here is how to do it.</p>', bodyText: 'Here is how to do it.',
    })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Sam Tech · IT');
  });

  test('a quoted Auto-help answer keeps its own signature once, no second one, no photo', async () => {
    signatureRow.mockResolvedValue({ enabled: true, html: '<p>Sam Tech · IT</p>', text: 'Sam Tech · IT', spacing: null });
    findMany.mockResolvedValue([entry({
      id: 52, source: 'ticketpulse_user', actorName: 'Ticket Pulse (Auto-help)', actorEmail: null,
      bodyHtml: '<p>Restart the VPN client.</p><div style="margin:16px 0 0" data-tp-signature="auto-help"><p>IT Service Desk</p><img src="https://example.com/logo.png" alt="logo"></div>',
      bodyText: 'Restart the VPN client.',
    })]);
    const budget = pictures.createInlineBudget();
    const quote = await ticketService._lastInboundQuote(1, null, { budget });
    expect(quote.html.match(/IT Service Desk/g)).toHaveLength(1);
    expect(quote.html).not.toContain('Sam Tech · IT');
    expect(quote.html).toContain('src="https://example.com/logo.png"');
    expect(inlinePhotoAttachment).not.toHaveBeenCalled();
    expect(pictures.inlineAttachments(budget)).toEqual([]);
  });

  test("a requester's message never gets one of our signatures", async () => {
    signatureRow.mockResolvedValue({ enabled: true, html: '<p>Sam Tech · IT</p>', text: 'Sam Tech · IT', spacing: null });
    findMany.mockResolvedValue([entry({ occurredAt: new Date('2026-10-01T18:00:00Z') })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Sam Tech · IT');
  });
});
