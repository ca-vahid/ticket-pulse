// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as pdfLib from 'pdf-lib';
import TicketAttachmentsTab from './TicketAttachmentsTab';
import { ticketsAPI } from '../../services/api';
import { encryptedPdf, tinyPdf, tinyPng } from './attachmentMerge.testUtils';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => new Promise(() => {})),
    attachmentBytes: vi.fn(),
    uploadAttachments: vi.fn(),
    saveBlob: vi.fn(),
  },
}));

const at = '2026-11-20T18:00:00Z';
const file = (id, fileName, contentType, extra = {}) => ({ id, fileName, contentType, sizeBytes: 2048, source: 'email', createdAt: at, ...extra });
const FILES = [
  file(1, 'invoice 1042.pdf', 'application/pdf'),
  file(2, 'receipt.png', 'image/png', { createdAt: '2026-11-20T17:00:00Z' }),
  file(3, 'terms.pdf', 'application/pdf', { createdAt: '2026-11-20T16:00:00Z' }),
  file(4, 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { createdAt: '2026-11-20T15:00:00Z' }),
];
let bytesById;

const renderTab = (props = {}) => render(
  <TicketAttachmentsTab ticketId={42} attachments={FILES} canUpload ticketRef="TP-1042" subject="Expense claim" loadPdfLib={() => Promise.resolve(pdfLib)} {...props} />,
);

const readFile = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(new Uint8Array(r.result));
  r.onerror = reject;
  r.readAsArrayBuffer(blob);
});

beforeEach(async () => {
  localStorage.clear();
  bytesById = { 1: await tinyPdf(2, 210), 2: tinyPng(), 3: await tinyPdf(1, 230), 4: new ArrayBuffer(10) };
  ticketsAPI.attachmentBytes.mockReset();
  ticketsAPI.uploadAttachments.mockReset();
  ticketsAPI.attachmentBytes.mockImplementation((ticketId, id) => Promise.resolve(bytesById[id].slice(0)));
  ticketsAPI.uploadAttachments.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('Attachments tab · Merge into one PDF (QA 11-23 #5)', () => {
  test('checkboxes in grid and list; the bar counts, clears, and needs two files', () => {
    renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    const bar = screen.getByTestId('attachments-selection-bar');
    expect(bar).toHaveTextContent('1 selected');
    expect(within(bar).getByRole('button', { name: /Merge into one PDF/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    // Selection survives the view switch.
    expect(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    expect(screen.getByTestId('attachments-selection-bar')).toHaveTextContent('2 selected');
    expect(screen.getByRole('button', { name: /Merge into one PDF/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByTestId('attachments-selection-bar')).not.toBeInTheDocument();
  });

  test('no checkboxes when the agent cannot add files', () => {
    renderTab({ canUpload: false });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('a Word file in the selection blocks the merge in plain words', () => {
    renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select notes.docx' }));
    expect(screen.getByTestId('attachments-merge-blocker')).toHaveTextContent('Only PDFs and images can be merged. Take out notes.docx.');
    expect(screen.getByRole('button', { name: /Merge into one PDF/ })).toBeDisabled();
  });

  test('reorder with the up/down buttons, rename, merge, attach as a new file', async () => {
    const onMerged = vi.fn();
    renderTab({ onMerged });
    // Picked order: terms, invoice, receipt.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt.png' }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into one PDF/ }));

    const dialog = screen.getByRole('dialog', { name: 'Merge into one PDF' });
    const order = () => within(screen.getByTestId('merge-pdf-order')).getAllByRole('listitem').map((li) => li.textContent);
    expect(order()[0]).toContain('terms.pdf');
    const name = within(dialog).getByRole('textbox', { name: 'File name' });
    expect(name).toHaveValue('Merged - terms.pdf');
    expect(name).toHaveFocus();

    // Move the invoice to the top: the default name follows the first file.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move invoice 1042.pdf up' }));
    expect(order().map((t) => t.match(/(invoice 1042|terms|receipt)/)[1])).toEqual(['invoice 1042', 'terms', 'receipt']);
    expect(name).toHaveValue('Merged - invoice 1042.pdf');
    // Up on the first row does nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move invoice 1042.pdf up' }));
    expect(order()[0]).toContain('invoice 1042.pdf');

    fireEvent.change(name, { target: { value: 'Expense claim TP-1042' } });
    expect(within(dialog).getByRole('group', { name: 'Pictures fit on' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'A4' }));
    fireEvent.click(within(dialog).getByTestId('merge-pdf-confirm'));

    await waitFor(() => expect(ticketsAPI.uploadAttachments).toHaveBeenCalledTimes(1));
    const [ticketId, files] = ticketsAPI.uploadAttachments.mock.calls[0];
    expect(ticketId).toBe(42);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('Expense claim TP-1042.pdf');
    expect(files[0].type).toBe('application/pdf');
    expect(ticketsAPI.attachmentBytes.mock.calls.map((c) => c[1])).toEqual([1, 3, 2]);

    const merged = await pdfLib.PDFDocument.load(await readFile(files[0]));
    expect(merged.getPages().map((p) => Math.round(p.getWidth()))).toEqual([210, 210, 230, 595]);

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith({ fileName: 'Expense claim TP-1042.pdf', pageCount: 4, fileCount: 3 }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachments-selection-bar')).not.toBeInTheDocument();
  });

  test('a password-protected PDF keeps the dialog open with a plain message; taking it out lets the merge go', async () => {
    bytesById[3] = encryptedPdf();
    renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select receipt.png' }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into one PDF/ }));
    fireEvent.click(screen.getByTestId('merge-pdf-confirm'));

    expect(await screen.findByRole('alert')).toHaveTextContent('“terms.pdf” is password-protected, so it can\'t be merged.');
    expect(ticketsAPI.uploadAttachments).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Take terms.pdf out of the merge' }));
    fireEvent.click(screen.getByTestId('merge-pdf-confirm'));
    await waitFor(() => expect(ticketsAPI.uploadAttachments).toHaveBeenCalledTimes(1));
    expect(ticketsAPI.uploadAttachments.mock.calls[0][1][0].name).toBe('Merged - invoice 1042.pdf');
  });

  test('an upload failure keeps the dialog open so the agent can try again', async () => {
    ticketsAPI.uploadAttachments.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { data: { message: 'Attachments are limited to 100 MB each.' } } }));
    renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into one PDF/ }));
    fireEvent.click(screen.getByTestId('merge-pdf-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The PDF was made but could not be attached: Attachments are limited to 100 MB each. Try again.');
    expect(screen.getByTestId('merge-pdf-confirm')).toBeEnabled();
  });

  test('Escape closes the dialog and nothing is attached', () => {
    renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select invoice 1042.pdf' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into one PDF/ }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(ticketsAPI.uploadAttachments).not.toHaveBeenCalled();
    // The selection is kept for another go.
    expect(screen.getByTestId('attachments-selection-bar')).toHaveTextContent('2 selected');
  });
});
