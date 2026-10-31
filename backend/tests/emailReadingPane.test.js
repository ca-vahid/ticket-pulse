/**
 * 31 Oct 2026: in the new Outlook reading pane a reply's paragraphs ran together and
 * the signature logo was missing (the column it sits in stayed empty, so the
 * signature looked shifted right). The same message opened in its own window was
 * fine. Paragraphs now carry their spacing inline, and data: pictures go as cid
 * attachments, at both transports.
 */
import { jest } from '@jest/globals';

const axiosPostMock = jest.fn();
const settingsRepositoryMock = { getSendGridConfig: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: { post: axiosPostMock } }));
jest.unstable_mockModule('nodemailer', () => ({ default: { createTransport: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));

const { paragraphSpacing, inlineDataImages, prepareOutboundEmail } = await import('../src/utils/emailHtmlHardening.js');
const { sendEmail } = await import('../src/services/sendgridNotificationService.js');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('paragraphSpacing', () => {
  test('a bare paragraph gets the browser default above and below', () => {
    expect(paragraphSpacing('<p>Hi Paul,</p><p>BST is back up.</p>'))
      .toBe('<p style="margin-top:1em;margin-bottom:1em">Hi Paul,</p><p style="margin-top:1em;margin-bottom:1em">BST is back up.</p>');
  });

  test('the closing paragraph keeps its zero bottom and gains a top', () => {
    expect(paragraphSpacing('<p style="margin-bottom:0">Thanks,<br />Vahid</p>'))
      .toBe('<p style="margin-bottom:0;margin-top:1em">Thanks,<br />Vahid</p>');
  });

  test('a margin shorthand, Word paragraphs and non-paragraph tags are left alone', () => {
    const html = '<p style="margin: 0">sig</p><p class="MsoNormal">quoted</p><pre>code</pre><param name="x">';
    expect(paragraphSpacing(html)).toBe(html);
  });

  test('other attributes survive and it is idempotent', () => {
    const once = paragraphSpacing('<p dir="ltr" style=\'color:red\'>x</p>');
    expect(once).toBe('<p dir="ltr" style="color:red;margin-top:1em;margin-bottom:1em">x</p>');
    expect(paragraphSpacing(once)).toBe(once);
  });
});

describe('inlineDataImages', () => {
  test('a data: picture becomes one cid attachment, shared by identical copies', () => {
    const html = `<img src="data:image/png;base64,${PNG}" width="100"><img alt="" src='data:image/png;base64,${PNG}'>`;
    const out = inlineDataImages(html);
    expect(out.html).toBe('<img src="cid:tp-img-1" width="100"><img alt="" src=\'cid:tp-img-1\'>');
    expect(out.attachments).toEqual([{ name: 'image1.png', contentType: 'image/png', contentBytes: PNG, contentId: 'tp-img-1' }]);
  });

  test('past the 1 MB total the rest stay as they were (Graph request size)', () => {
    const big = (fill) => `data:image/png;base64,${fill.repeat(Math.floor((600 * 1024) / 0.75))}`;
    const out = inlineDataImages(`<img src="${big('A')}"><img src="${big('B')}">`);
    expect(out.attachments).toHaveLength(1);
    expect(out.html).toContain('src="cid:tp-img-1"');
    expect(out.html).toContain(`src="${big('B')}"`);
  });

  test('ordinary pictures and text are untouched', () => {
    const html = '<img src="cid:tp-face-1"><img src="https://example.com/a.png"><p>data:image/png;base64,abc</p>';
    expect(inlineDataImages(html)).toEqual({ html, attachments: [] });
  });

  test('prepareOutboundEmail keeps the caller attachments first', () => {
    const own = { name: 'log.txt', contentType: 'text/plain', contentBytes: 'eA==' };
    const out = prepareOutboundEmail({ html: `<p>x</p><img src="data:image/png;base64,${PNG}">`, attachments: [own] });
    expect(out.html).toBe('<p style="margin-top:1em;margin-bottom:1em">x</p><img src="cid:tp-img-1">');
    expect(out.attachments.map((a) => a.contentId || a.name)).toEqual(['log.txt', 'tp-img-1']);
  });
});

describe('SendGrid transport', () => {
  test('sends the logo as an inline attachment and the paragraphs spaced', async () => {
    settingsRepositoryMock.getSendGridConfig.mockResolvedValue({ apiKey: 'SG.test', fromEmail: 'tp@example.com' });
    axiosPostMock.mockResolvedValue({ headers: {} });
    await sendEmail({
      to: 'requester@example.com',
      subject: 'Re: BST [TP-1]',
      html: `<p>Hi,</p><p>Back up.</p><table><tr><td><img src="data:image/png;base64,${PNG}" width="100"></td></tr></table>`,
      text: 'Hi, back up.',
    });
    const payload = axiosPostMock.mock.calls[0][1];
    const html = payload.content.find((c) => c.type === 'text/html').value;
    expect(html).toContain('<p style="margin-top:1em;margin-bottom:1em">Hi,</p>');
    expect(html).toContain('src="cid:tp-img-1"');
    expect(html).not.toContain('data:image');
    expect(payload.attachments).toEqual([
      { content: PNG, filename: 'image1.png', type: 'image/png', disposition: 'inline', content_id: 'tp-img-1' },
    ]);
  });
});
