// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';
import TicketAttachmentsTab from './TicketAttachmentsTab';
import { ticketsAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => new Promise(() => {})),
    attachmentBytes: vi.fn(),
    saveBlob: vi.fn(),
  },
}));

const at = '2026-11-02T17:00:00Z';
const file = (id, fileName, extra = {}) => ({ id, fileName, contentType: 'text/plain', sizeBytes: 1024, source: 'email', createdAt: at, ...extra });

async function unzipSaved() {
  await waitFor(() => expect(ticketsAPI.saveBlob).toHaveBeenCalledTimes(1));
  const [blob, name] = ticketsAPI.saveBlob.mock.calls[0];
  const buf = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsArrayBuffer(blob);
  });
  return { name, entries: unzipSync(new Uint8Array(buf)) };
}

const renderTab = (attachments, props = {}) => render(
  <TicketAttachmentsTab ticketId={42} attachments={attachments} ticketRef="TP-11375" subject="QA TEST - Macros Testing" {...props} />,
);

beforeEach(() => {
  ticketsAPI.attachmentBytes.mockReset();
  ticketsAPI.saveBlob.mockReset();
  ticketsAPI.attachmentBytes.mockImplementation((ticketId, id) => Promise.resolve(new TextEncoder().encode(`bytes of ${id}`).buffer));
});

afterEach(cleanup);

describe('Attachments tab · Download all', () => {
  test('hidden with no or one attachment, shown with two or more', () => {
    const { rerender } = renderTab([]);
    expect(screen.queryByTestId('attachments-download-all')).not.toBeInTheDocument();
    rerender(<TicketAttachmentsTab ticketId={42} attachments={[file(1, 'one.txt')]} />);
    expect(screen.queryByTestId('attachments-download-all')).not.toBeInTheDocument();
    rerender(<TicketAttachmentsTab ticketId={42} attachments={[file(1, 'one.txt'), file(2, 'two.txt')]} />);
    expect(screen.getByRole('button', { name: 'Download all 2 files as one zip' })).toBeInTheDocument();
  });

  test('fetches every listed file and saves one zip named after the ticket', async () => {
    renderTab([file(1, 'invoice.txt'), file(2, 'scan.pdf', { contentType: 'application/pdf' }), file(3, 'log.txt')]);
    fireEvent.click(screen.getByTestId('attachments-download-all'));
    const { name, entries } = await unzipSaved();
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(3);
    expect(ticketsAPI.attachmentBytes.mock.calls.map((c) => [c[0], c[1]])).toEqual(expect.arrayContaining([[42, 1], [42, 2], [42, 3]]));
    expect(name).toBe('TP-11375 QA TEST - Macros Testing - attachments.zip');
    expect(Object.keys(entries).sort()).toEqual(['invoice.txt', 'log.txt', 'scan.pdf']);
    expect(strFromU8(entries['scan.pdf'])).toBe('bytes of 2');
    expect(screen.queryByTestId('attachments-download-all-note')).not.toBeInTheDocument();
  });

  test('a file that fails goes into missing-files.txt and the zip still downloads', async () => {
    ticketsAPI.attachmentBytes.mockImplementation((ticketId, id) => (id === 2
      ? Promise.reject(Object.assign(new Error('Request failed'), { response: { status: 502 } }))
      : Promise.resolve(new TextEncoder().encode(`bytes of ${id}`).buffer)));
    renderTab([file(1, 'kept.txt'), file(2, 'from-freshservice.docx'), file(3, 'also-kept.txt')]);
    fireEvent.click(screen.getByTestId('attachments-download-all'));
    const { entries } = await unzipSaved();
    expect(Object.keys(entries).sort()).toEqual(['also-kept.txt', 'kept.txt', 'missing-files.txt']);
    expect(strFromU8(entries['missing-files.txt'])).toContain('from-freshservice.docx (server error 502)');
    const note = await screen.findByTestId('attachments-download-all-note');
    expect(note).toHaveTextContent('Zip downloaded with 2 of 3 files');
    expect(note).toHaveTextContent('from-freshservice.docx');
  });

  test('duplicate file names get " (2)"', async () => {
    renderTab([file(1, 'photo.txt'), file(2, 'photo.txt')]);
    fireEvent.click(screen.getByTestId('attachments-download-all'));
    const { entries } = await unzipSaved();
    expect(Object.keys(entries).sort()).toEqual(['photo (2).txt', 'photo.txt']);
  });

  test('over ~300 MB asks first, inline', async () => {
    const big = 200 * 1024 * 1024;
    renderTab([file(1, 'big-a.txt', { sizeBytes: big }), file(2, 'big-b.txt', { sizeBytes: big })]);
    fireEvent.click(screen.getByTestId('attachments-download-all'));
    expect(screen.getByRole('group', { name: 'Confirm large download' })).toHaveTextContent('These 2 files add up to');
    expect(ticketsAPI.attachmentBytes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Zip anyway' }));
    await unzipSaved();
    expect(ticketsAPI.attachmentBytes).toHaveBeenCalledTimes(2);
  });

  test('cancel while zipping saves nothing', async () => {
    ticketsAPI.attachmentBytes.mockImplementation((ticketId, id, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('canceled')));
    }));
    renderTab([file(1, 'a.txt'), file(2, 'b.txt')]);
    fireEvent.click(screen.getByTestId('attachments-download-all'));
    expect(await screen.findByRole('button', { name: 'Cancel download all (Zipping 1 of 2…)' })).toHaveTextContent('Zipping 1 of 2…');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download all' }));
    expect(await screen.findByText(/Download all cancelled/)).toBeInTheDocument();
    expect(ticketsAPI.saveBlob).not.toHaveBeenCalled();
  });

  test('zips only what the current filter lists, and says so', async () => {
    const entries = [{ id: 'n1', isPrivate: true, occurredAt: at }];
    renderTab([
      file(1, 'requester-1.txt'), file(2, 'requester-2.txt'),
      file(3, 'note-1.txt', { threadEntryId: 'n1', source: 'note' }), file(4, 'note-2.txt', { threadEntryId: 'n1', source: 'note' }),
    ], { entries });
    fireEvent.click(screen.getByRole('tab', { name: /Internal notes/ }));
    const btn = screen.getByTestId('attachments-download-all');
    expect(btn).toHaveAttribute('title', 'Download the 2 files listed under “Internal notes” as one zip');
    fireEvent.click(btn);
    const { entries: zipped } = await unzipSaved();
    expect(Object.keys(zipped).sort()).toEqual(['note-1.txt', 'note-2.txt']);
  });
});
