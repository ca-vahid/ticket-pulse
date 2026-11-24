// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { unzipSync } from 'fflate';
import TicketAttachmentsTab from './TicketAttachmentsTab';
import AttachmentPreviewModal from './AttachmentPreviewModal';
import { ticketsAPI } from '../../services/api';
import {
  attachmentName, composeName, nameProblem, namedAutomaticallyTitle, originalNameIfRenamed, splitExtension,
} from './attachmentNames';
import { buildHistoryItems } from '../../utils/ticketHistory';

vi.mock('../../services/api', () => ({
  ticketsAPI: {
    attachmentObjectUrl: vi.fn(() => new Promise(() => {})),
    attachmentBytes: vi.fn(),
    saveBlob: vi.fn(),
    uploadAttachments: vi.fn(),
    downloadAttachment: vi.fn(() => Promise.resolve()),
    renameAttachment: vi.fn(),
  },
}));
vi.mock('./attachmentPreview/pdfjsLoader', () => ({ openPdf: vi.fn() }));

const at = '2026-11-23T18:00:00Z';
const NEW_NAME = 'Acme Supplies_INV-100234_2026_11_23.pdf';
const renamed = (extra = {}) => ({
  id: 1,
  fileName: 'INV-100234.pdf',
  originalName: 'INV-100234.pdf',
  displayName: NEW_NAME,
  nameSource: 'auto',
  nameDetails: { vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', documentDate: '2026-11-23', dateFrom: 'document', method: 'rules+ai', confidence: 'high' },
  contentType: 'application/pdf',
  sizeBytes: 2048,
  source: 'email',
  createdAt: at,
  ...extra,
});
const plain = (id, fileName, extra = {}) => ({
  id, fileName, originalName: fileName, displayName: null, nameSource: null, nameDetails: null, contentType: 'application/pdf', sizeBytes: 1024, source: 'email', createdAt: '2026-11-23T17:00:00Z', ...extra,
});

const renderTab = (props = {}) => render(
  <TicketAttachmentsTab ticketId={42} attachments={[renamed()]} canRename ticketRef="TP-1042" subject="Invoice from Acme Supplies" {...props} />,
);

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom */ }
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('attachment names · helpers', () => {
  test('the shown name, the original and the extension', () => {
    expect(attachmentName(renamed())).toBe(NEW_NAME);
    expect(attachmentName(plain(2, 'scan.pdf'))).toBe('scan.pdf');
    expect(originalNameIfRenamed(renamed())).toBe('INV-100234.pdf');
    expect(originalNameIfRenamed(plain(2, 'scan.pdf'))).toBeNull();
    // An edit back to the original name is not "renamed".
    expect(originalNameIfRenamed(renamed({ displayName: 'INV-100234.pdf', nameSource: 'manual' }))).toBeNull();
    expect(splitExtension('Acme Supplies_INV-1.pdf')).toEqual({ base: 'Acme Supplies_INV-1', ext: '.pdf' });
    expect(splitExtension('README')).toEqual({ base: 'README', ext: '' });
  });

  test('typed names: plain-word problems, extension kept once', () => {
    expect(nameProblem('   ')).toBe('Type a name for the file.');
    expect(nameProblem('Acme: inv?')).toBe("File names can't contain : or ?. Take them out.");
    expect(nameProblem('a/b')).toBe("File names can't contain /. Take it out.");
    expect(nameProblem('x'.repeat(121))).toMatch(/120 characters or fewer/);
    expect(nameProblem('Acme Supplies_INV-1')).toBeNull();
    expect(composeName('  Acme   Supplies_INV-1 ', '.pdf')).toBe('Acme Supplies_INV-1.pdf');
    expect(composeName('Acme Supplies_INV-1.PDF', '.pdf')).toBe('Acme Supplies_INV-1.pdf');
    expect(composeName('Acme v1.2', '.pdf')).toBe('Acme v1.2.pdf');
  });

  test('the "named automatically" hover text says vendor, number, date and how', () => {
    expect(namedAutomaticallyTitle(renamed())).toBe('Named automatically. Vendor: Acme Supplies · Number: INV-100234 · Dated Nov 23, 2026 · Found from the e-mail, checked by reading the document');
    expect(namedAutomaticallyTitle(renamed({ nameDetails: { vendor: 'Acme Supplies', documentDate: null, dateFrom: 'received', method: 'rules' } })))
      .toBe('Named automatically. Vendor: Acme Supplies · Date: when the e-mail arrived · Found from the e-mail subject, sender and file name');
  });
});

describe('Attachments tab · names (4.4.08)', () => {
  test('shows the new name with the original as a quiet line, in grid and list', () => {
    renderTab();
    const name = screen.getByTestId('attachment-name');
    expect(within(name).getByText(NEW_NAME)).toBeInTheDocument();
    const was = within(name).getByTestId('attachment-original-name');
    // "Named automatically" leads, so a long original name can't cut it off.
    expect(was).toHaveTextContent(/^Named automatically · was INV-100234\.pdf$/);
    expect(within(was).getByText(/Named automatically/)).toHaveAttribute('title', expect.stringContaining('Vendor: Acme Supplies'));
    expect(screen.getByRole('button', { name: `Download ${NEW_NAME}` })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('button', { name: NEW_NAME })).toHaveAttribute('title', `Preview ${NEW_NAME}`);
    expect(screen.getByTestId('attachment-original-name')).toHaveTextContent('was INV-100234.pdf');
    expect(screen.getByRole('button', { name: /^Revert/ })).toBeInTheDocument();
  });

  test('a file with no new name shows only its name, and no Revert', () => {
    renderTab({ attachments: [plain(2, 'scan.pdf')] });
    expect(screen.getByText('scan.pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('attachment-original-name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit name of scan.pdf' })).toBeInTheDocument();
  });

  test('no Edit name or Revert without edit rights', () => {
    renderTab({ canRename: false });
    expect(screen.getByText(NEW_NAME)).toBeInTheDocument();
    expect(screen.getByTestId('attachment-original-name')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit name/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.queryByRole('button', { name: /Edit name/ })).not.toBeInTheDocument();
  });

  test('Revert puts the original name back at once and says so', async () => {
    const onRenamed = vi.fn();
    ticketsAPI.renameAttachment.mockResolvedValue({ success: true, data: renamed({ displayName: null, nameSource: 'reverted' }) });
    renderTab({ onRenamed });
    const revert = screen.getByRole('button', { name: `Revert ${NEW_NAME} to its original name, INV-100234.pdf` });
    expect(revert).toHaveTextContent('Revert');
    fireEvent.click(revert);

    expect(ticketsAPI.renameAttachment).toHaveBeenCalledWith(42, 1, { action: 'revert' });
    expect(await screen.findByRole('status')).toHaveTextContent('Name put back to INV-100234.pdf.');
    expect(screen.getByText('INV-100234.pdf')).toBeInTheDocument();
    expect(screen.queryByText(NEW_NAME)).not.toBeInTheDocument();
    expect(screen.queryByTestId('attachment-original-name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Revert/ })).not.toBeInTheDocument();
    expect(onRenamed).toHaveBeenCalledWith(1, expect.objectContaining({ displayName: null, nameSource: 'reverted' }), expect.any(Object));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit name of INV-100234.pdf' })).toHaveFocus());
  });

  test('a failed revert keeps the name and says why', async () => {
    ticketsAPI.renameAttachment.mockRejectedValue(new Error('Attachment not found'));
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /^Revert/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not put the name back: Attachment not found.');
    expect(screen.getByText(NEW_NAME)).toBeInTheDocument();
  });

  test('Edit name: the box holds the name without its extension; Enter saves', async () => {
    ticketsAPI.renameAttachment.mockResolvedValue({ success: true, data: renamed({ displayName: 'Acme Supplies November.pdf', nameSource: 'manual' }) });
    const onRenamed = vi.fn();
    renderTab({ onRenamed });
    fireEvent.click(screen.getByRole('button', { name: `Edit name of ${NEW_NAME}` }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    expect(box).toHaveValue('Acme Supplies_INV-100234_2026_11_23');
    expect(box).toHaveFocus();
    expect(screen.getByText('.pdf')).toBeInTheDocument();
    expect(box).toHaveAccessibleDescription(/ends in \.pdf, which stays/);

    // Typing the extension again does not double it.
    fireEvent.change(box, { target: { value: 'Acme Supplies November.pdf' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(ticketsAPI.renameAttachment).toHaveBeenCalledWith(42, 1, { action: 'edit', name: 'Acme Supplies November.pdf' });
    expect(await screen.findByRole('status')).toHaveTextContent('Renamed to Acme Supplies November.pdf.');
    expect(screen.queryByRole('textbox', { name: 'New name' })).not.toBeInTheDocument();
    expect(screen.getByText('Acme Supplies November.pdf')).toBeInTheDocument();
    // A person's name is not "named automatically".
    expect(screen.getByTestId('attachment-original-name')).toHaveTextContent(/^was INV-100234\.pdf$/);
    expect(screen.getByTestId('attachment-original-name')).not.toHaveTextContent(/named automatically/i);
    expect(onRenamed).toHaveBeenCalledWith(1, expect.objectContaining({ displayName: 'Acme Supplies November.pdf', nameSource: 'manual' }), expect.any(Object));
  });

  test('Edit name: the Save button works too, and the server\'s answer is what shows', async () => {
    // The server adds " (2)" when another file has the name.
    ticketsAPI.renameAttachment.mockResolvedValue({ success: true, data: renamed({ displayName: 'Acme Supplies (2).pdf', nameSource: 'manual' }) });
    renderTab();
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), { target: { value: 'Acme Supplies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Renamed to Acme Supplies (2).pdf.');
  });

  test('Escape cancels: nothing saved, focus back on Edit name', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: 'Something else' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'New name' })).not.toBeInTheDocument();
    expect(ticketsAPI.renameAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(NEW_NAME)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Edit name/ })).toHaveFocus());
  });

  test('an empty name is refused in plain words', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Type a name for the file.');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(ticketsAPI.renameAttachment).not.toHaveBeenCalled();
  });

  test('characters a file name cannot have are flagged as they are typed', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: 'Acme: invoice?' } });
    expect(screen.getByRole('alert')).toHaveTextContent("File names can't contain : or ?. Take them out.");
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(ticketsAPI.renameAttachment).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'Acme invoice' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('polish 11-24: the error and the box edge use the destructive token', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: 'Acme: invoice?' } });
    const error = screen.getByRole('alert');
    expect(error).toHaveClass('text-destructive');
    expect(error.className).not.toMatch(/red-/);
    expect(box.parentElement).toHaveClass('border-destructive');
    expect(box.parentElement.className).not.toMatch(/red-/);
    fireEvent.change(box, { target: { value: 'Acme invoice' } });
    expect(box.parentElement).toHaveClass('border-input');
    expect(box.parentElement).not.toHaveClass('border-destructive');
    // A failed revert reads in the same token.
    fireEvent.keyDown(box, { key: 'Escape' });
    ticketsAPI.renameAttachment.mockRejectedValue(new Error('Attachment not found'));
    fireEvent.click(screen.getByRole('button', { name: /^Revert/ }));
    const note = await screen.findByRole('alert');
    expect(note).toHaveClass('text-destructive');
    expect(note.className).not.toMatch(/red-/);
  });

  test('polish 11-24: a long original name wraps instead of hiding "Named automatically"', () => {
    const long = `INV-100234_${'scanned-copy-'.repeat(12)}final.pdf`;
    renderTab({ attachments: [renamed({ fileName: long, originalName: long })] });
    const was = screen.getByTestId('attachment-original-name');
    expect(was).toHaveTextContent(`Named automatically · was ${long}`);
    expect(was.textContent.startsWith('Named automatically')).toBe(true);
    expect(was).not.toHaveClass('truncate');
    expect(was.className).toMatch(/overflow-wrap:anywhere/);
    // The label is still "Revert" (the product owner's word).
    expect(screen.getByRole('button', { name: /^Revert/ })).toHaveTextContent(/^Revert$/);
  });

  test('an unchanged name closes the box without a request', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'New name' }), { key: 'Enter' });
    expect(ticketsAPI.renameAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'New name' })).not.toBeInTheDocument();
  });

  test('a server refusal keeps the box open with the reason', async () => {
    ticketsAPI.renameAttachment.mockRejectedValue(new Error('Type a name for the file.'));
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /Edit name/ }));
    const box = screen.getByRole('textbox', { name: 'New name' });
    fireEvent.change(box, { target: { value: 'Acme' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the name: Type a name for the file. Try again.');
    expect(screen.getByRole('textbox', { name: 'New name' })).toBeInTheDocument();
  });

  test('the merge default name uses the shown name of the first file', () => {
    renderTab({ canUpload: true, attachments: [renamed(), plain(2, 'terms.pdf')] });
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NEW_NAME}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select terms.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: /Merge into one PDF/ }));
    const dialog = screen.getByRole('dialog', { name: 'Merge into one PDF' });
    expect(within(dialog).getByRole('textbox', { name: 'File name' })).toHaveValue('Merged - Acme Supplies_INV-100234_2026_11_23.pdf');
    expect(within(dialog).getByRole('button', { name: `Move ${NEW_NAME} up` })).toBeInTheDocument();
  });

  test('Download and "Download all" use the shown name', async () => {
    const onDownload = vi.fn();
    ticketsAPI.attachmentBytes.mockImplementation((ticketId, id) => Promise.resolve(new TextEncoder().encode(`bytes of ${id}`).buffer));
    renderTab({ onDownload, attachments: [renamed(), plain(2, 'terms.pdf')] });
    fireEvent.click(screen.getByRole('button', { name: `Download ${NEW_NAME}` }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ id: 1, displayName: NEW_NAME }));

    fireEvent.click(screen.getByTestId('attachments-download-all'));
    await waitFor(() => expect(ticketsAPI.saveBlob).toHaveBeenCalledTimes(1));
    const [blob] = ticketsAPI.saveBlob.mock.calls[0];
    const buf = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(blob);
    });
    expect(Object.keys(unzipSync(new Uint8Array(buf))).sort()).toEqual([NEW_NAME, 'terms.pdf']);
  });
});

describe('Preview · names (4.4.08)', () => {
  test('the preview shows the new name and downloads under it', () => {
    const doc = renamed({ id: 5, fileName: 'INV-100234.doc', originalName: 'INV-100234.doc', displayName: 'Acme Supplies_INV-100234_2026_11_23.doc', contentType: 'application/msword' });
    render(<AttachmentPreviewModal ticketId={42} attachment={doc} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Preview Acme Supplies_INV-100234_2026_11_23.doc' })).toBeInTheDocument();
    expect(screen.getByTestId('attachment-preview-was')).toHaveTextContent('was INV-100234.doc');
    fireEvent.click(screen.getByRole('button', { name: /Download file/ }));
    expect(ticketsAPI.downloadAttachment).toHaveBeenCalledWith(42, 5, 'Acme Supplies_INV-100234_2026_11_23.doc');
  });
});

describe('History · attachment_renamed', () => {
  const row = (id, action, extra = {}) => ({
    id, activityType: 'attachment_renamed', performedBy: action === 'auto' ? 'Ticket Pulse' : 'Dana Fox', performedAt: at,
    details: { attachmentId: 1, action, from: 'INV-100234.pdf', to: NEW_NAME, originalName: 'INV-100234.pdf', method: 'rules+ai', ...extra },
  });

  test('auto, edit and revert read as plain sentences', () => {
    const items = buildHistoryItems({ activities: [row(1, 'auto'), row(2, 'edit', { from: NEW_NAME, to: 'Acme November.pdf' }), row(3, 'revert', { from: 'Acme November.pdf', to: 'INV-100234.pdf' })] });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['a-1']).toMatchObject({ verb: 'named a file automatically', from: 'INV-100234.pdf', to: NEW_NAME, detail: 'Found from the e-mail and the document', machine: false });
    expect(byKey['a-2']).toMatchObject({ verb: 'renamed a file', from: NEW_NAME, to: 'Acme November.pdf', actor: 'Dana Fox' });
    expect(byKey['a-3']).toMatchObject({ verb: 'put back a file\'s original name', to: 'INV-100234.pdf' });
  });
});
