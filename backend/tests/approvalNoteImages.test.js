import { jest } from '@jest/globals';

/** Pictures in an approval request note (19 Oct 2026): e-mail, magic link and Teams show them. */

const prismaMock = { ticketAttachment: { findMany: jest.fn() } };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
process.env.PUBLIC_API_URL = 'https://api.example.test/';

const {
  noteImageNames, findNoteImages, noteHtmlWithImages, noteTextForPreview, noteTextWithoutMarkers,
  noteImagePath, tokenFromDecisionUrl, imagePixelWidth,
} = await import('../src/services/approvalNoteImages.js');

const at = (iso) => new Date(iso);

describe('approval note pictures', () => {
  test('names come from the text and the HTML, once each, &nbsp; tolerated', () => {
    expect(noteImageNames('[Image: pasted-image-1.png]', '<i>[Image:&nbsp;Pasted-Image-1.PNG]</i> and <i>[Image: b.jpg]</i>'))
      .toEqual(['pasted-image-1.png', 'b.jpg']);
    expect(noteImageNames('no pictures here')).toEqual([]);
  });

  test('each name resolves to the newest copy uploaded by the time the request was made', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([
      { id: 1, fileName: 'pasted-image-1.png', contentType: 'image/png', createdAt: at('2026-10-01T10:00:00Z') },
      { id: 2, fileName: 'pasted-image-1.png', contentType: 'image/png', createdAt: at('2026-10-19T16:37:30Z') },
      { id: 3, fileName: 'pasted-image-1.png', contentType: 'image/png', createdAt: at('2026-10-20T09:00:00Z') },
    ]);
    const images = await findNoteImages({ id: 9, ticketId: 5, workspaceId: 1, requestNote: '[Image: pasted-image-1.png]', createdAt: at('2026-10-19T16:37:32Z') });
    expect(images.map((i) => i.id)).toEqual([2]);
    expect(prismaMock.ticketAttachment.findMany.mock.calls[0][0].where).toEqual(expect.objectContaining({ ticketId: 5, workspaceId: 1 }));
  });

  test('a note with no markers looks nothing up', async () => {
    prismaMock.ticketAttachment.findMany.mockClear();
    expect(await findNoteImages({ ticketId: 5, requestNote: 'Plain words' })).toEqual([]);
    expect(prismaMock.ticketAttachment.findMany).not.toHaveBeenCalled();
  });

  test('the marker (and the <i> the composer wraps it in) becomes the picture; unknown names stay text', () => {
    const html = noteHtmlWithImages('<p>See <i>[Image: pasted-image-1.png]</i> and [Image: gone.png]</p>', null,
      [{ id: 2, name: 'pasted-image-1.png', fileName: 'pasted-image-1.png' }],
      { srcFor: (img) => `cid:note-image-${img.id}`, widthFor: () => 480 });
    expect(html).toContain('<img src="cid:note-image-2" alt="pasted-image-1.png" width="480"');
    expect(html).not.toContain('<i>');
    expect(html).toContain('[Image: gone.png]');
  });

  test('a plain-text note is escaped into HTML before the picture goes in', () => {
    const html = noteHtmlWithImages(null, 'Price <b>\n[Image: a.png]', [{ id: 4, name: 'a.png', fileName: 'a.png' }], { srcFor: () => '/x' });
    expect(html).toBe('Price &lt;b&gt;<br><img src="/x" alt="a.png" style="display:block;max-width:100%;height:auto;margin:6px 0;border:1px solid #e2e8f0;border-radius:6px;">');
  });

  test('previews and card text', () => {
    expect(noteTextForPreview('[Image: pasted-image-1.png]')).toBe('(picture)');
    expect(noteTextWithoutMarkers('Quote below [Image: a.png]')).toBe('Quote below');
    expect(noteTextForPreview('')).toBeNull();
  });

  test('token links', () => {
    expect(tokenFromDecisionUrl('https://tp.example/approval/abc%2Bdef?intent=ask')).toBe('abc+def');
    expect(tokenFromDecisionUrl('https://tp.example/approvals')).toBeNull();
    expect(noteImagePath('tok', 7)).toBe('/api/ticket-approvals/public/tok/image/7');
    expect(noteImagePath('tok', 7, { absolute: true })).toBe('https://api.example.test/api/ticket-approvals/public/tok/image/7');
  });

  test('pixel width from PNG, GIF and JPEG headers', () => {
    const png = Buffer.alloc(32); png.set([0x89, 0x50, 0x4e, 0x47]); png.writeUInt32BE(1200, 16);
    const gif = Buffer.alloc(32); gif.set([0x47, 0x49, 0x46]); gif.writeUInt16LE(300, 6);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imagePixelWidth(png)).toBe(1200);
    expect(imagePixelWidth(gif)).toBe(300);
    expect(imagePixelWidth(jpg)).toBe(640);
    expect(imagePixelWidth(Buffer.from('nope'))).toBeNull();
  });
});
