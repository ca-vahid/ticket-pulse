// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AttachmentPreviewModal, { noPreviewMessage, previewKind, wheelZoomDelta } from './AttachmentPreviewModal';
import { openPdf } from './attachmentPreview/pdfjsLoader';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => Promise.resolve({ url: 'blob:picture' })),
    downloadAttachment: vi.fn(),
  },
}));

// pdf.js is a lazy chunk behind this loader; the tests hand the viewer a fake document.
vi.mock('./attachmentPreview/pdfjsLoader', () => ({ openPdf: vi.fn() }));

// jsdom has no object URLs; the modal revokes its blob URL 300 ms after a file
// closes, which can land after a test on a slow run.
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};

const picture = { id: 7, fileName: 'pasted-image-1.png', contentType: 'image/png', sizeBytes: 151000 };

/** 21 Oct 2026: the wheel zooms the picture and never scrolls the ticket; the preview can be maximized. */
describe('AttachmentPreviewModal wheel and maximize', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  const open = async () => {
    render(<AttachmentPreviewModal ticketId={1} attachment={picture} onClose={() => {}} />);
    await screen.findByRole('img', { name: picture.fileName });
    await act(async () => {}); // let the wheel listener re-attach for the loaded picture
  };

  const wheel = (target, deltaY) => {
    const e = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(e); });
    return e;
  };

  test('a wheel over the picture zooms it and cancels the page scroll', async () => {
    await open();
    const e = wheel(screen.getByRole('img', { name: picture.fileName }), -100);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('135%');
  });

  test('a wheel over the header or the backdrop does not scroll the page either', async () => {
    await open();
    const e = wheel(screen.getByRole('button', { name: 'Download' }), 100);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toHaveTextContent('100%');
  });

  test('a trackpad nudge zooms a little, a mouse notch one step', () => {
    expect(wheelZoomDelta({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(0.35);
    expect(wheelZoomDelta({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(0.35);
    expect(wheelZoomDelta({ deltaY: -4, deltaMode: 0 })).toBeCloseTo(0.014);
    expect(wheelZoomDelta({ deltaY: 500, deltaMode: 0 })).toBeCloseTo(-0.35);
  });

  test('Maximize fills the window, F toggles it, and the choice is remembered', async () => {
    await open();
    const card = screen.getByTestId('attachment-preview-card');
    expect(card.className).not.toMatch(/\bh-full w-full\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    expect(card.className).toMatch(/\bh-full w-full\b/);
    expect(localStorage.getItem('tp.attachmentPreview.full')).toBe('1');
    fireEvent.keyDown(document, { key: 'f' });
    expect(screen.getByRole('button', { name: 'Maximize' })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('tp.attachmentPreview.full')).toBe('0');
  });
});

/** QA 11-06 #3: PDFs, e-mails and Word files that the old preview couldn't show. */
describe('previewKind and the no-preview message', () => {
  test('PDFs are recognised by name even when the server calls them octet-stream', () => {
    expect(previewKind({ fileName: 'Quote-1042.pdf', contentType: 'application/octet-stream' })).toBe('pdf');
    expect(previewKind({ fileName: 'scan', contentType: 'application/pdf' })).toBe('pdf');
  });

  test('.eml, .msg and message/rfc822 open as e-mails, not as text', () => {
    expect(previewKind({ fileName: 'Fwd- printer quote.eml', contentType: 'application/octet-stream' })).toBe('email');
    expect(previewKind({ fileName: 'RE- laptop order.msg', contentType: 'application/octet-stream' })).toBe('email');
    expect(previewKind({ fileName: 'attached-message', contentType: 'message/rfc822' })).toBe('email');
    expect(previewKind({ fileName: 'notes.txt', contentType: 'text/plain' })).toBe('text');
  });

  test('old Word, PowerPoint and zip files keep the download card with a specific reason', () => {
    expect(previewKind({ fileName: 'Policy 2009.doc', contentType: 'application/msword' })).toBe('none');
    expect(previewKind({ fileName: 'deck.pptx' })).toBe('none');
    expect(previewKind({ fileName: 'logs.zip' })).toBe('none');
    expect(previewKind({ fileName: 'letter.docx' })).toBe('docx');
    expect(noPreviewMessage({ fileName: 'Policy 2009.doc' })).toBe('Old Word (.doc) files can’t be shown in the browser — download to open it');
    expect(noPreviewMessage({ fileName: 'deck.pptx' })).toMatch(/PowerPoint/);
    expect(noPreviewMessage({ fileName: 'logs.zip' })).toMatch(/Zip archives/);
    expect(noPreviewMessage({ fileName: 'model.step' })).toBe('.step files can’t be shown in the browser — download to open it');
  });

  test('the download card says why a .doc has no preview', async () => {
    render(<AttachmentPreviewModal ticketId={1} attachment={{ id: 9, fileName: 'Policy 2009.doc', sizeBytes: 40960 }} onClose={() => {}} />);
    expect(screen.getByText(/Old Word \(\.doc\) files can’t be shown in the browser/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download file/ })).toBeInTheDocument();
  });
});

const bytes = (text) => new TextEncoder().encode(text).buffer;
const stubFetch = (buffer) => vi.stubGlobal('fetch', vi.fn(async () => ({
  arrayBuffer: async () => buffer,
  text: async () => new TextDecoder().decode(buffer),
})));

function fakePdf(numPages) {
  const page = {
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
  };
  return { numPages, getPage: vi.fn(() => Promise.resolve(page)), page };
}

describe('PDF viewer', () => {
  const pdfFile = { id: 21, fileName: 'Quote-1042.pdf', contentType: 'application/octet-stream', sizeBytes: 88000 };
  let getContext;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom */ }
    stubFetch(bytes('%PDF-1.7 fake'));
    getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn() }));
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); getContext.mockRestore(); });

  test('shows the page count, a thumbnail per page and moves between pages', async () => {
    const doc = fakePdf(3);
    openPdf.mockReturnValue({ promise: Promise.resolve(doc), destroy: vi.fn() });
    render(<AttachmentPreviewModal ticketId={1} attachment={pdfFile} onClose={() => {}} />);

    const pageInput = await screen.findByRole('textbox', { name: 'Page number' });
    await waitFor(() => expect(screen.getByText('of 3')).toBeInTheDocument());
    expect(pageInput).toHaveValue('1');
    // pdf.js got a copy of the bytes, whatever the server's content type said.
    expect(openPdf).toHaveBeenCalledWith(expect.any(Uint8Array));

    const rail = screen.getByRole('navigation', { name: 'Pages' });
    const thumbs = within(rail).getAllByRole('button', { name: /^Page \d$/ });
    expect(thumbs).toHaveLength(3);
    expect(thumbs[0]).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('img', { name: /^Page \d of 3$/ })).toHaveLength(3);
    await waitFor(() => expect(doc.page.render).toHaveBeenCalled());

    fireEvent.click(thumbs[2]);
    expect(pageInput).toHaveValue('3');
    expect(thumbs[2]).toHaveAttribute('aria-current', 'page');
    expect(thumbs[0]).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    fireEvent.keyDown(document, { key: 'PageUp' });
    expect(pageInput).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(pageInput).toHaveValue('1');

    fireEvent.change(pageInput, { target: { value: '9' } });
    fireEvent.keyDown(pageInput, { key: 'Enter' });
    expect(pageInput).toHaveValue('3'); // clamped to the last page

    fireEvent.click(screen.getByRole('button', { name: 'Hide page thumbnails' }));
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    expect(localStorage.getItem('tp.attachmentPreview.pdfRail')).toBe('0');
  });

  test('a PDF pdf.js cannot open falls back to the browser viewer with a note', async () => {
    // jsdom has no object URLs; lend it a pair for this test.
    const createObjectURL = vi.fn(() => 'blob:fallback');
    const had = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    // The modal revokes its blob URL 300 ms after closing, so leave a no-op behind.
    onTestFinished(() => { URL.createObjectURL = had.create; URL.revokeObjectURL = had.revoke || (() => {}); });
    openPdf.mockReturnValue({ promise: Promise.reject(Object.assign(new Error('No password given'), { name: 'PasswordException' })), destroy: vi.fn() });
    render(<AttachmentPreviewModal ticketId={1} attachment={pdfFile} onClose={() => {}} />);

    expect(await screen.findByText(/password-protected/)).toBeInTheDocument();
    const frame = await screen.findByTitle(pdfFile.fileName);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'blob:fallback');
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/pdf');
  });
});

describe('E-mail viewer', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  const eml = [
    'From: "Avery Example" <avery@example.com>',
    'To: Help Desk <helpdesk@example.com>',
    'Cc: Jordan Sample <jordan@example.com>',
    'Subject: Printer on floor 3 is jammed',
    'Date: Thu, 05 Nov 2026 09:15:00 -0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The printer shows <b>error 42</b>.</p><script>window.__pwned = true</script><img src="x" onerror="window.__pwned = true">',
    '--b1',
    'Content-Type: text/plain; name="printer-log.txt"',
    'Content-Disposition: attachment; filename="printer-log.txt"',
    '',
    'paper jam at tray 2',
    '--b1--',
    '',
  ].join('\r\n');

  test('shows the mail header, the sanitized body and the message’s own attachments', async () => {
    stubFetch(bytes(eml));
    const { container } = render(
      <AttachmentPreviewModal ticketId={1} attachment={{ id: 31, fileName: 'Printer on floor 3.eml', contentType: 'application/octet-stream' }} onClose={() => {}} />,
    );

    expect(await screen.findByRole('heading', { name: 'Printer on floor 3 is jammed' })).toBeInTheDocument();
    const view = screen.getByTestId('email-preview');
    expect(within(view).getByText('Avery Example <avery@example.com>')).toBeInTheDocument();
    expect(within(view).getByText('Help Desk <helpdesk@example.com>')).toBeInTheDocument();
    expect(within(view).getByText('Jordan Sample <jordan@example.com>')).toBeInTheDocument();
    expect(within(view).getByText('Date')).toBeInTheDocument();
    expect(within(view).getByText('error 42')).toBeInTheDocument();
    expect(within(view).getByRole('list', { name: 'Attachments in this e-mail' })).toHaveTextContent('printer-log.txt');

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  test('an unreadable e-mail file falls back to the download card', async () => {
    stubFetch(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]).buffer);
    render(<AttachmentPreviewModal ticketId={1} attachment={{ id: 32, fileName: 'broken.msg', contentType: 'application/octet-stream' }} onClose={() => {}} />);
    expect(await screen.findByText(/couldn’t be read here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download file/ })).toBeInTheDocument();
  });
});
