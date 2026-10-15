/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// QA 10-13 #1 to #4: what an e-mail looks like once it is a ticket.

const attachmentObjectUrl = vi.fn();
vi.mock('../../services/api', () => ({
  ticketsAPI: { attachmentObjectUrl: (...args) => attachmentObjectUrl(...args) },
}));

import { RichBody, SentSignature, _resetPictureCache, imageRefNames, openingMessageHtml, openingRepeatsDescription, picturesShownInBody } from './InlineImageBody';

// The description of TP-1885 as stored (shortened): the logo cell of the signature.
const SIGNATURE_HTML = '<div>Testing out ticket creation speed in ticket pulse</div>'
  + '<table style="width:400pt; table-layout:fixed"><tbody><tr>'
  + '<td style="width:69pt"><p style="font-size:0pt"><span><p><em>[Image: picture-1-9jCAAA-image.png]</em></p></span></p></td>'
  + '<td><p><b>Susan Xu, </b>B.A.Sc.</p><p>IT Coordinator</p></td></tr></tbody></table>';
const LOGO = { id: 70932, fileName: 'picture-1-9jCAAA-image.png', contentType: 'image/png', sizeBytes: 39593 };
const SCREENSHOT = { id: 70934, fileName: 'picture-1-9jDAAA-image.png', contentType: 'image/png', sizeBytes: 2941575 };

beforeEach(() => {
  _resetPictureCache();
  attachmentObjectUrl.mockReset();
  attachmentObjectUrl.mockImplementation((ticketId, id) => Promise.resolve({ url: `blob:ticket-${ticketId}-file-${id}`, type: 'image/png' }));
});
afterEach(cleanup);

describe('RichBody: pictures where they were', () => {
  test('the signature logo is shown in place of "[Image: name]", through the signed-in download', async () => {
    render(<RichBody html={SIGNATURE_HTML} ticketId={62963} inlineImages={[LOGO]} onImageRef={() => {}} />);
    const img = await screen.findByAltText('picture-1-9jCAAA-image.png');
    expect(img).toHaveAttribute('src', 'blob:ticket-62963-file-70932');
    expect(img).toHaveClass('tp-inline-img');
    expect(attachmentObjectUrl).toHaveBeenCalledWith(62963, 70932);
    expect(screen.queryByText(/\[Image:/)).toBeNull();
    // The rest of the signature keeps its layout.
    expect(screen.getByText('IT Coordinator')).toBeInTheDocument();
  });

  test('a click (or Enter) on the picture opens it by name', async () => {
    const onImageRef = vi.fn();
    render(<RichBody html={`<div><p><em>[Image: ${SCREENSHOT.fileName}]</em></p></div>`} ticketId={62969} inlineImages={[SCREENSHOT]} onImageRef={onImageRef} />);
    const img = await screen.findByAltText(SCREENSHOT.fileName);
    fireEvent.click(img);
    expect(onImageRef).toHaveBeenCalledWith(SCREENSHOT.fileName);
    const button = screen.getByRole('button', { name: `Open picture ${SCREENSHOT.fileName}` });
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onImageRef).toHaveBeenCalledTimes(2);
  });

  test('a picture pasted in the reply editor (non-breaking space in the marker) is matched too', async () => {
    const pasted = { id: 9, fileName: 'pasted-image-1.png', contentType: 'image/png' };
    render(<RichBody html="<p>See below&nbsp;<i>[Image:&nbsp;pasted-image-1.png]</i>&nbsp;</p>" ticketId={1} inlineImages={[pasted]} />);
    expect(await screen.findByAltText('pasted-image-1.png')).toHaveAttribute('src', 'blob:ticket-1-file-9');
  });

  test('a name with no matching picture stays a link, and nothing is fetched', () => {
    render(<RichBody html="<p>[Image: gone.png]</p>" ticketId={1} inlineImages={[LOGO]} />);
    expect(screen.getByText(/gone\.png/)).toHaveClass('tp-img-ref');
    expect(attachmentObjectUrl).not.toHaveBeenCalled();
  });

  test('the same picture in two bodies is downloaded once', async () => {
    render(
      <>
        <RichBody html={SIGNATURE_HTML} ticketId={62963} inlineImages={[LOGO]} />
        <RichBody html={SIGNATURE_HTML} ticketId={62963} inlineImages={[LOGO]} />
      </>,
    );
    await waitFor(() => expect(screen.getAllByAltText(LOGO.fileName)).toHaveLength(2));
    expect(attachmentObjectUrl).toHaveBeenCalledTimes(1);
  });

  test('when the download fails the link stays, so the agent can still open the file', async () => {
    attachmentObjectUrl.mockRejectedValueOnce(new Error('offline'));
    render(<RichBody html={SIGNATURE_HTML} ticketId={62963} inlineImages={[LOGO]} />);
    await waitFor(() => expect(attachmentObjectUrl).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: `Open picture ${LOGO.fileName}` })).toHaveTextContent(LOGO.fileName);
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('the sanitiser is untouched: a picture address written in the mail is never used, scripts are dropped', async () => {
    const hostile = '<p><em>[Image: picture-1-9jCAAA-image.png]</em></p>'
      + '<span class="tp-img-ref tp-img-ref--inline" data-img="other.png">x</span>'
      + '<img src="cid:abc"><script>window.hacked = 1</script><p onclick="window.hacked = 2">text</p>';
    const { container } = render(<RichBody html={hostile} ticketId={62963} inlineImages={[LOGO]} />);
    await screen.findByAltText(LOGO.fileName);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    // The planted marker names a file that is not on this ticket: nothing is fetched for it.
    expect(attachmentObjectUrl).toHaveBeenCalledTimes(1);
  });

  test('without a ticket (peek, previews) the body renders as before: a link, no download', () => {
    render(<RichBody html={SIGNATURE_HTML} inlineImages={[LOGO]} />);
    expect(screen.getByText(/picture-1-9jCAAA-image\.png/)).toHaveClass('tp-img-ref');
    expect(attachmentObjectUrl).not.toHaveBeenCalled();
  });
});

describe('which pictures a body shows', () => {
  test('imageRefNames and picturesShownInBody match on the file name, any case', () => {
    expect([...imageRefNames('<i>[Image:&nbsp;Pasted-Image-1.PNG]</i>', 'and [Image: b.jpg]')]).toEqual(['pasted-image-1.png', 'b.jpg']);
    const other = { id: 2, fileName: 'invoice-scan.png' };
    expect(picturesShownInBody([LOGO, other], SIGNATURE_HTML)).toEqual([LOGO]);
    expect(picturesShownInBody([LOGO], '<p>no pictures</p>')).toEqual([]);
  });
});

describe('openingMessageHtml: the opening e-mail entry written before 13 Oct 2026', () => {
  // TP-1886 as stored: the entry is Graph's preview, cut at 255 characters.
  const preview = 'Susan Xu, B.A.Sc. (she/her)\r\n\r\nIT Coordinator\r\n\r\nBGC Engineering\r\n\r\n\r\n\r\nM: 604-315-6761   E: sxu@bgcengineering.ca\r\n\r\nSuite 500 – 980 Howe Street, Vancouver, BC V6Z 0C8\r\n\r\nwww.bgcengineering.ca\r\n\r\nWe respectfully acknowledge that our Vancouver office is';
  const ticket = {
    description: '<div><p><em>[Image: picture-1-9jDAAA-image.png]</em></p></div><table><tr><td><b>Susan Xu, </b>B.A.Sc.</td></tr></table><p><i>We respectfully acknowledge that our Vancouver office is located on the traditional, ancestral, and unceded territories of the xʷməθkʷəy̓əm (Musqueam), Sḵwx̱wú7mesh (Squamish), and səlilwətaɬ (Tsleil-Waututh) Nations.</i></p>',
    descriptionText: ' [Image: picture-1-9jDAAA-image.png] \n \n Susan Xu, B.A.Sc. (she/her) \n IT Coordinator \n BGC Engineering \n \n M: 604-315-6761 E: sxu@bgcengineering.ca \n Suite 500 – 980 Howe Street, Vancouver, BC V6Z 0C8 \n www.bgcengineering.ca \n We respectfully acknowledge that our Vancouver office is located on the traditional, ancestral, and unceded territories of the xʷməθkʷəy̓əm (Musqueam), Sḵwx̱wú7mesh (Squamish), and səlilwətaɬ (Tsleil-Waututh) Nations.',
  };
  const entry = { eventType: 'original_email', bodyHtml: null, bodyText: preview };

  test('a cut preview that the description starts with is shown as the whole formatted message', () => {
    expect(openingMessageHtml(entry, ticket)).toBe(ticket.description);
  });

  test('not when the description was changed, the entry has its own HTML, or it is another kind of entry', () => {
    expect(openingMessageHtml(entry, { ...ticket, descriptionText: 'Rewritten by the agent after triage.' })).toBeNull();
    expect(openingMessageHtml({ ...entry, bodyHtml: '<p>own</p>' }, ticket)).toBeNull();
    expect(openingMessageHtml({ ...entry, eventType: 'reply' }, ticket)).toBeNull();
    expect(openingMessageHtml(entry, { description: null, descriptionText: null })).toBeNull();
  });

  test('the land acknowledgement and its letters reach the page whole', () => {
    render(<RichBody html={openingMessageHtml(entry, ticket)} text={entry.bodyText} />);
    expect(screen.getByText(/xʷməθkʷəy̓əm \(Musqueam\), Sḵwx̱wú7mesh \(Squamish\), and səlilwətaɬ \(Tsleil-Waututh\) Nations\./)).toBeInTheDocument();
  });
});

describe('openingRepeatsDescription: the opening e-mail folds when it says what the Description says (QA 10-14 #5)', () => {
  // An e-mail ticket as stored since 4.2.70: the entry is the whole mail, the description the same mail.
  const html = '<div><p>Hello,</p><p>I received an encrypted message from a supplier on the bridge project.&nbsp;I am trying to open it.</p><p>Thank you!<br>Robin</p></div>';
  const ticket = { description: html, descriptionText: 'Hello,\n\nI received an encrypted message from a supplier on the bridge project. I am trying to open it.\n\nThank you!\nRobin' };

  test('a whole stored mail, and an older cut preview, both fold', () => {
    expect(openingRepeatsDescription({ eventType: 'original_email', bodyHtml: html, bodyText: ticket.descriptionText }, ticket)).toBe(true);
    expect(openingRepeatsDescription({ eventType: 'original_email', bodyHtml: null, bodyText: 'Hello,\r\n\r\nI received an encrypted message from a supplier' }, ticket)).toBe(true);
    expect(openingRepeatsDescription({ eventType: 'original_email', bodyHtml: html }, { description: html })).toBe(true);
  });

  test('a rewritten description, a reply, or too little text stays in full', () => {
    const entry = { eventType: 'original_email', bodyHtml: html, bodyText: ticket.descriptionText };
    expect(openingRepeatsDescription(entry, { ...ticket, descriptionText: 'Rewritten by the agent after triage: user cannot open an encrypted mail.' })).toBe(false);
    expect(openingRepeatsDescription({ ...entry, eventType: 'reply' }, ticket)).toBe(false);
    expect(openingRepeatsDescription({ eventType: 'original_email', bodyText: 'Hi' }, ticket)).toBe(false);
    expect(openingRepeatsDescription(entry, { description: null, descriptionText: null })).toBe(false);
  });
});

describe('SentSignature: the signature that went out with an agent reply', () => {
  test('is shown under the reply as it was sent', () => {
    const entry = { rawPayload: { sentSignature: { html: '<p style="margin: 0"><b>Susan Xu, </b>B.A.Sc.</p><p style="margin: 0">IT Coordinator</p>', text: 'Susan Xu, B.A.Sc.\nIT Coordinator' } } };
    render(<SentSignature entry={entry} />);
    const block = screen.getByTestId('sent-signature');
    expect(block).toHaveTextContent('Susan Xu, B.A.Sc.');
    expect(block.querySelector('b')).not.toBeNull();
  });

  test('falls back to its text, and renders nothing for a reply stored before this release', () => {
    const { rerender, container } = render(<SentSignature entry={{ rawPayload: { sentSignature: { text: 'Susan Xu\nIT Coordinator' } } }} />);
    expect(screen.getByTestId('sent-signature')).toHaveTextContent('Susan Xu');
    rerender(<SentSignature entry={{ rawPayload: { to_emails: ['a@b.c'] } }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SentSignature entry={{ rawPayload: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
