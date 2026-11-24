// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import AttachmentThumbnail from './AttachmentThumbnail';
import { THUMB_CONCURRENCY, docxPreviewHtml, resetThumbnails, thumbKind } from './thumbnails';
import TicketAttachmentsTab from '../TicketAttachmentsTab';
import { ticketsAPI } from '../../../services/api';
import { openPdf } from './pdfjsLoader';
import { parseEmailFile } from './parseEmail';
import mammoth from 'mammoth/mammoth.browser';
import * as XLSX from 'xlsx';

vi.mock('../../../services/api', () => ({
  ticketsAPI: {
    attachmentBytes: vi.fn(),
    attachmentObjectUrl: vi.fn(() => new Promise(() => {})),
  },
}));
vi.mock('./pdfjsLoader', () => ({ openPdf: vi.fn() }));
vi.mock('./parseEmail', () => ({ parseEmailFile: vi.fn() }));
vi.mock('mammoth/mammoth.browser', () => ({ default: { convertToHtml: vi.fn() } }));
vi.mock('xlsx', () => ({ read: vi.fn(), utils: { sheet_to_json: vi.fn() } }));

/** IntersectionObserver stand-in: nothing is "visible" until reveal(). */
let observers = [];
class MockObserver {
  constructor(cb) { this.cb = cb; this.els = new Set(); observers.push(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.els.clear(); }
}
function reveal() {
  act(() => {
    observers.slice().forEach((o) => {
      const els = [...o.els];
      if (els.length) o.cb(els.map((target) => ({ target, isIntersecting: true })), o);
    });
  });
}

const bytes = (s) => new TextEncoder().encode(s).buffer;
const file = (id, fileName, extra = {}) => ({ id, fileName, sizeBytes: 2048, ...extra });
const ICON = <span>type icon</span>;
const show = (a) => render(<AttachmentThumbnail ticketId={7} attachment={a} fallback={ICON} />);
const thumb = () => screen.getByTestId('attachment-thumb');
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const origGetContext = HTMLCanvasElement.prototype.getContext;
const origToBlob = HTMLCanvasElement.prototype.toBlob;
const origDpr = window.devicePixelRatio;

beforeEach(() => {
  observers = [];
  vi.stubGlobal('IntersectionObserver', MockObserver);
  resetThumbnails();
  vi.clearAllMocks();
  ticketsAPI.attachmentBytes.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:thumb-page-1');
  URL.revokeObjectURL = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillRect: vi.fn(), fillStyle: '' }));
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb) { cb(new Blob(['png'], { type: 'image/png' })); };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  HTMLCanvasElement.prototype.getContext = origGetContext;
  HTMLCanvasElement.prototype.toBlob = origToBlob;
  Object.defineProperty(window, 'devicePixelRatio', { value: origDpr, configurable: true, writable: true });
});

describe('thumbKind', () => {
  test('maps the common formats and leaves the rest to the icon', () => {
    expect(thumbKind({ fileName: 'quote.pdf' })).toBe('pdf');
    expect(thumbKind({ fileName: 'blob', contentType: 'application/pdf' })).toBe('pdf');
    expect(thumbKind({ fileName: 'plan.docx' })).toBe('docx');
    expect(thumbKind({ fileName: 'budget.xlsx' })).toBe('sheet');
    expect(thumbKind({ fileName: 'old.xls' })).toBe('sheet');
    expect(thumbKind({ fileName: 'export.csv' })).toBe('sheet');
    expect(thumbKind({ fileName: 'setup.log' })).toBe('text');
    expect(thumbKind({ fileName: 'config.json' })).toBe('text');
    expect(thumbKind({ fileName: 'fwd.eml' })).toBe('email');
    expect(thumbKind({ fileName: 'deck.pptx' })).toBeNull();
    expect(thumbKind({ fileName: 'archive.zip' })).toBeNull();
  });
});

describe('AttachmentThumbnail — each type', () => {
  test('PDF: page 1 drawn at a capped pixel ratio, shown as a decorative image', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true, writable: true });
    const getViewport = vi.fn(({ scale }) => ({ width: 612 * scale, height: 792 * scale }));
    const render1 = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const destroy = vi.fn();
    openPdf.mockReturnValue({ promise: Promise.resolve({ getPage: async () => ({ getViewport, render: render1 }) }), destroy });
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('%PDF-1.7'));

    const { container } = show(file(1, 'quote.pdf'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'pdf'));
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'blob:thumb-page-1');
    expect(img).toHaveAttribute('alt', '');
    expect(img.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(img).toHaveClass('object-cover', 'object-top');
    // 320 CSS px wide at a DPR capped to 2, not the screen's 3.
    expect(getViewport).toHaveBeenLastCalledWith({ scale: 640 / 612 });
    expect(render1).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalled();
    expect(screen.queryByText('type icon')).not.toBeInTheDocument();
  });

  test('Word: the first paragraphs on a white paper well', async () => {
    mammoth.convertToHtml.mockResolvedValue({ value: '<h1>Rollout plan</h1><p>Hello <strong>team</strong>, here is the plan.</p>' });
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('PK docx'));
    show(file(2, 'plan.docx'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'docx'));
    const doc = screen.getByTestId('thumb-docx');
    expect(doc).toHaveTextContent('Rollout plan');
    expect(doc.querySelector('strong')).toHaveTextContent('team');
    expect(doc.closest('.tp-light')).not.toBeNull(); // stays light in dark mode
  });

  test('Sheet: first rows and columns as a tiny table', async () => {
    XLSX.read.mockReturnValue({ SheetNames: ['Stock'], Sheets: { Stock: {} } });
    XLSX.utils.sheet_to_json.mockReturnValue([
      ['Item', 'Qty', 'Site', 'Owner', 'Notes', 'Extra column'],
      [],
      ['Laptop', 4, 'North', 'Avery', 'ok', 'x'],
      ...Array.from({ length: 10 }, (_, i) => [`Row ${i}`, i, 'a', 'b', 'c', 'd']),
    ]);
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('PK xlsx'));
    show(file(3, 'stock.xlsx'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'sheet'));
    const table = screen.getByTestId('thumb-sheet');
    const body = table.querySelectorAll('tbody tr');
    expect(body).toHaveLength(6);
    expect(body[0].querySelectorAll('td')).toHaveLength(5);
    expect(within(table).getByText('Laptop')).toBeInTheDocument();
    expect(within(table).queryByText('Extra column')).not.toBeInTheDocument();
    expect(XLSX.read).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'array', sheetRows: expect.any(Number) }));
  });

  test('Text: the first lines in monospace', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `2026-11-24 line ${i}`).join('\n');
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes(lines));
    show(file(4, 'setup.log'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'text'));
    const pre = screen.getByTestId('thumb-text');
    expect(pre).toHaveTextContent('2026-11-24 line 0');
    expect(pre).not.toHaveTextContent('line 30');
    expect(pre).toHaveClass('font-mono');
  });

  test('E-mail: subject, sender and the start of the body', async () => {
    parseEmailFile.mockResolvedValue({ subject: 'Printer jammed', from: 'Avery Example <avery@example.com>', text: 'Hi,\n\nThe printer on 3 is jammed.' });
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('From: avery@example.com'));
    show(file(5, 'forwarded.eml'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'email'));
    const mail = screen.getByTestId('thumb-email');
    expect(mail).toHaveTextContent('Printer jammed');
    expect(mail).toHaveTextContent('The printer on 3 is jammed.');
  });
});

describe('AttachmentThumbnail — fallbacks and limits', () => {
  test('a failed download falls back to the icon', async () => {
    ticketsAPI.attachmentBytes.mockRejectedValue(new Error('Network down'));
    show(file(6, 'quote.pdf'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'icon'));
    expect(screen.getByText('type icon')).toBeInTheDocument();
  });

  test('a parser failure falls back to the icon', async () => {
    mammoth.convertToHtml.mockRejectedValue(new Error('Corrupt file'));
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('not a docx'));
    show(file(7, 'broken.docx'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'icon'));
    expect(screen.getByText('type icon')).toBeInTheDocument();
  });

  test('a binary file wearing a text name falls back to the icon', async () => {
    ticketsAPI.attachmentBytes.mockResolvedValue(new Uint8Array([0x4d, 0x5a, 0x00, 0x00, 0x03]).buffer);
    show(file(19, 'driver.log'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'icon'));
  });

  test('when the device saves data, nothing is fetched and the icon stays', async () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis.navigator, 'connection');
    Object.defineProperty(globalThis.navigator, 'connection', { value: { saveData: true }, configurable: true });
    try {
      show(file(20, 'small.pdf', { sizeBytes: 50 * 1024 }));
      reveal();
      await act(async () => { await Promise.resolve(); });
      expect(ticketsAPI.attachmentBytes).not.toHaveBeenCalled();
      expect(screen.getByText('type icon')).toBeInTheDocument();
    } finally {
      if (prev) Object.defineProperty(globalThis.navigator, 'connection', prev); else delete globalThis.navigator.connection;
    }
  });

  test('files over 4 MB are never fetched', async () => {
    show(file(8, 'huge.pdf', { sizeBytes: 5 * 1024 * 1024 }));
    reveal();
    await act(async () => { await Promise.resolve(); });
    expect(ticketsAPI.attachmentBytes).not.toHaveBeenCalled();
    expect(screen.getByText('type icon')).toBeInTheDocument();
  });

  test('nothing is fetched until the card is visible', async () => {
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('hello'));
    show(file(9, 'readme.txt'));
    await act(async () => { await Promise.resolve(); });
    expect(ticketsAPI.attachmentBytes).not.toHaveBeenCalled();
    expect(thumb()).toHaveAttribute('data-thumb', 'icon');
    reveal();
    expect(thumb()).toHaveAttribute('data-thumb', 'loading');
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'text'));
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(1);
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledWith(7, 9, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test(`at most ${THUMB_CONCURRENCY} load at once; the next starts when one finishes`, async () => {
    const calls = [];
    ticketsAPI.attachmentBytes.mockImplementation((ticketId, id) => {
      const d = deferred();
      calls.push({ id, d });
      return d.promise;
    });
    render(
      <>
        {[11, 12, 13, 14].map((id) => <AttachmentThumbnail key={id} ticketId={7} attachment={file(id, `f${id}.txt`)} fallback={ICON} />)}
      </>,
    );
    reveal();
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(calls).toHaveLength(2);
    expect(screen.getAllByTestId('attachment-thumb').filter((el) => el.dataset.thumb === 'loading')).toHaveLength(4);

    await act(async () => { calls[0].d.resolve(bytes('first')); });
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => c.id)).toEqual([11, 12, 13]);
  });

  test('a cached thumbnail is reused without a second fetch', async () => {
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('cached text'));
    const first = show(file(15, 'notes.txt'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'text'));
    first.unmount();

    show(file(15, 'notes.txt'));
    // Straight from the cache: no observer needed, no shimmer, no fetch.
    expect(thumb()).toHaveAttribute('data-thumb', 'text');
    expect(screen.getByTestId('thumb-text')).toHaveTextContent('cached text');
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(1);
  });

  test('a failure is cached too, so the file is not fetched again', async () => {
    ticketsAPI.attachmentBytes.mockRejectedValue(new Error('Forbidden'));
    const first = show(file(16, 'locked.pdf'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'icon'));
    first.unmount();
    show(file(16, 'locked.pdf'));
    reveal();
    await act(async () => { await Promise.resolve(); });
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(1);
  });

  test('leaving the page aborts the download', async () => {
    let seen = null;
    ticketsAPI.attachmentBytes.mockImplementation((ticketId, id, { signal }) => { seen = signal; return new Promise(() => {}); });
    const view = show(file(17, 'slow.pdf'));
    reveal();
    await waitFor(() => expect(seen).not.toBeNull());
    expect(seen.aborted).toBe(false);
    view.unmount();
    expect(seen.aborted).toBe(true);
  });
});

describe('AttachmentThumbnail — sanitising Word HTML', () => {
  const hostile = [
    '<p>Safe text</p>',
    '<script>window.__thumbPwned = 1</script>',
    '<img src="x" onerror="window.__thumbPwned = 2">',
    '<p onclick="steal()" style="background:url(https://example.com/t.png)">More text</p>',
    '<a href="javascript:alert(1)">a link</a>',
    '<iframe src="https://example.com"></iframe>',
  ].join('');

  test('docxPreviewHtml keeps text and drops scripts, images, links and attributes', () => {
    const out = docxPreviewHtml(hostile);
    expect(out).toContain('Safe text');
    expect(out).toContain('More text');
    expect(out).toContain('a link');
    expect(out).not.toMatch(/<script|<img|<iframe|<a\b|onerror|onclick|style=|javascript:/i);
  });

  test('the rendered thumbnail carries no active content', async () => {
    mammoth.convertToHtml.mockResolvedValue({ value: hostile });
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('PK docx'));
    show(file(18, 'hostile.docx'));
    reveal();
    await waitFor(() => expect(thumb()).toHaveAttribute('data-thumb', 'docx'));
    const doc = screen.getByTestId('thumb-docx');
    expect(doc).toHaveTextContent('Safe text');
    expect(doc.querySelector('script, img, iframe, a, [onclick], [onerror], [style]')).toBeNull();
    expect(window.__thumbPwned).toBeUndefined();
  });

  test('only the first blocks of a long document are kept', () => {
    const long = Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
    const out = docxPreviewHtml(long);
    expect(out).toContain('Paragraph 0');
    expect(out).not.toContain('Paragraph 30');
  });
});

describe('Attachments tab grid', () => {
  test('a PDF card shows its first page once scrolled into view; list view stays as it was', async () => {
    try { localStorage.setItem('tp_attach_view', 'grid'); } catch { /* jsdom */ }
    const getViewport = ({ scale }) => ({ width: 612 * scale, height: 792 * scale });
    openPdf.mockReturnValue({
      promise: Promise.resolve({ getPage: async () => ({ getViewport, render: () => ({ promise: Promise.resolve() }) }) }),
      destroy: vi.fn(),
    });
    ticketsAPI.attachmentBytes.mockResolvedValue(bytes('%PDF-1.7'));
    const pdf = { id: 21, fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 4096, source: 'email', createdAt: '2026-11-24T16:00:00Z' };
    const zip = { id: 22, fileName: 'logs.zip', contentType: 'application/zip', sizeBytes: 4096, source: 'email', createdAt: '2026-11-24T16:00:00Z' };
    render(<TicketAttachmentsTab ticketId={7} attachments={[pdf, zip]} />);

    expect(ticketsAPI.attachmentBytes).not.toHaveBeenCalled();
    reveal();
    await waitFor(() => expect(screen.getByTestId('attachment-thumb')).toHaveAttribute('data-thumb', 'pdf'));
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(1);
    // The zip has no thumbnail: icon and type label only.
    expect(screen.getByText('ZIP')).toBeInTheDocument();
    // The card keeps a name: the preview button is labelled with the file.
    expect(screen.getByRole('button', { name: 'Preview invoice.pdf' })).toBeInTheDocument();

    act(() => { screen.getByRole('radio', { name: 'List' }).click(); });
    expect(screen.queryByTestId('attachment-thumb')).not.toBeInTheDocument();
    try { localStorage.removeItem('tp_attach_view'); } catch { /* jsdom */ }
  });
});
