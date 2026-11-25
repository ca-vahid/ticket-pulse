/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ForwardAttachmentPicker from './ForwardAttachmentPicker';
import { defaultForwardSelection, forwardAttachmentIds, groupForwardAttachments, includesInternal } from './forwardAttachments';

// QA 11-24 #5: "Include the original attachments" on a forward.

const MB = 1024 * 1024;
const invoice = { id: 12, fileName: 'scan0001.pdf', displayName: 'Acme Supplies_INV-4471_2026_11_20.pdf', contentType: 'application/pdf', sizeBytes: 120000 };
const po = { id: 14, fileName: 'po.pdf', contentType: 'application/pdf', sizeBytes: 90000 };
const photo = { id: 17, fileName: 'site-photo.jpg', contentType: 'image/jpeg', sizeBytes: 800000 };
const drawings = { id: 16, fileName: 'drawings.zip', contentType: 'application/zip', sizeBytes: 4 * MB };
const logo = { id: 15, fileName: 'image001.png', contentType: 'image/png', sizeBytes: 4000 };
const shown = { id: 18, fileName: 'screen.png', contentType: 'image/png', sizeBytes: 50000 };
const signature = { id: 19, fileName: 'logo.png', contentType: 'image/png', sizeBytes: 3000, recurring: true };
const all = [invoice, po, photo, drawings, logo, shown, signature];

afterEach(cleanup);

describe('grouping and the default selection', () => {
  test('pictures from inside a message are set apart; attached pictures stay files', () => {
    const { files, pictures } = groupForwardAttachments(all, new Set([18]));
    expect(files.map((a) => a.id)).toEqual([12, 14, 17, 16]);
    // image001.png (Outlook's inline name), one shown in a message, a signature logo.
    expect(pictures.map((a) => a.id)).toEqual([15, 18, 19]);
  });

  test('on by default with every file that fits in an e-mail ticked; off when there are none', () => {
    const { files } = groupForwardAttachments(all, new Set([18]));
    expect(defaultForwardSelection(files)).toEqual({ include: true, ids: [12, 14, 17] });
    expect(defaultForwardSelection([])).toEqual({ include: false, ids: [] });
  });

  // Review 24 Nov 2026: an internal note's screenshot went to outside recipients by default.
  test('files of internal notes, earlier forwards and unknown entries are set apart and never in the default', () => {
    const entries = [
      { id: 60, eventType: 'original_email', isPrivate: false },
      { id: 61, eventType: 'note', isPrivate: true },
      { id: 62, eventType: 'forward', isPrivate: true, rawPayload: { directReply: { email: 'tim@example.com' } } },
      { id: 63, eventType: 'reply', isPrivate: false },
    ];
    const list = [
      { ...invoice, threadEntryId: null },
      { ...po, threadEntryId: 63 },
      { id: 30, threadEntryId: 61, fileName: 'internal-screenshot.png', contentType: 'image/png', sizeBytes: 5000 },
      { id: 31, threadEntryId: 62, fileName: 'sent-to-tim.pdf', contentType: 'application/pdf', sizeBytes: 5000 },
      { id: 32, threadEntryId: 999, fileName: 'unknown.pdf', contentType: 'application/pdf', sizeBytes: 5000 },
    ];
    const { files, internal } = groupForwardAttachments(list, null, entries);
    expect(files.map((a) => a.id)).toEqual([12, 14]);
    expect(internal.map((a) => a.id)).toEqual([30, 31, 32]);
    expect(defaultForwardSelection(files).ids).toEqual([12, 14]);
    expect(includesInternal([12, 14], internal)).toBe(false);
    expect(includesInternal([12, 30], internal)).toBe(true);
  });

  test('the ids sent: none when the box is off, never a file no longer on the ticket', () => {
    expect(forwardAttachmentIds({ include: false, ids: [12] }, all)).toEqual([]);
    expect(forwardAttachmentIds({ include: true, ids: [12, 99] }, all)).toEqual([12]);
  });
});

function Harness({ initial = null }) {
  const { files, pictures } = groupForwardAttachments(all, new Set([18]));
  const [value, setValue] = useState(initial || defaultForwardSelection(files));
  return (
    <>
      <ForwardAttachmentPicker files={files} pictures={pictures} value={value} onChange={setValue} />
      <output data-testid="ids">{forwardAttachmentIds(value, all).join(',')}</output>
    </>
  );
}

describe('ForwardAttachmentPicker', () => {
  test('the box, ticked, with the file count; each file listed under its shown name, ticked', () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox', { name: 'Include the original attachments (4)' });
    expect(box).toBeChecked();
    const list = screen.getByRole('list', { name: 'Attachments to include' });
    expect(within(list).getByText('Acme Supplies_INV-4471_2026_11_20.pdf')).toBeInTheDocument();
    expect(within(list).queryByText('scan0001.pdf')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Include Acme Supplies_INV-4471_2026_11_20.pdf' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Include po.pdf' })).toBeChecked();
    expect(screen.getByTestId('ids')).toHaveTextContent('12,14,17');
  });

  test('a file over 3 MB is shown but cannot be ticked, and says why', () => {
    render(<Harness />);
    const big = screen.getByRole('checkbox', { name: 'Include drawings.zip' });
    expect(big).not.toBeChecked();
    expect(big).toBeDisabled();
    expect(screen.getByText('over 3 MB, too big to e-mail')).toBeInTheDocument();
  });

  test('unticking one file, or the whole box', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include po.pdf' }));
    expect(screen.getByTestId('ids')).toHaveTextContent('12,17');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include the original attachments (4)' }));
    expect(screen.getByTestId('ids')).toHaveTextContent('');
    expect(screen.queryByRole('list', { name: 'Attachments to include' })).toBeNull();
  });

  test('pictures from the e-mail are left out, behind "Show pictures from the e-mail (n)"', () => {
    render(<Harness />);
    expect(screen.queryByRole('checkbox', { name: 'Include image001.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show pictures from the e-mail (3)' }));
    const pic = screen.getByRole('checkbox', { name: 'Include image001.png' });
    expect(pic).not.toBeChecked();
    fireEvent.click(pic);
    expect(screen.getByTestId('ids')).toHaveTextContent('12,14,17,15');
  });

  test('more than one e-mail can carry together: a warning to untick some', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, fileName: `page-${i}.pdf`, contentType: 'application/pdf', sizeBytes: 2.9 * MB }));
    render(<ForwardAttachmentPicker files={many} pictures={[]} value={{ include: true, ids: many.map((a) => a.id) }} onChange={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/more than one e-mail can carry .* Untick some/);
  });

  test('"From internal notes (n)": folded, unticked, and a file can still be ticked on purpose', () => {
    const note = { id: 30, threadEntryId: 61, fileName: 'internal-screenshot.png', contentType: 'image/png', sizeBytes: 5000 };
    function WithInternal() {
      const [value, setValue] = useState(defaultForwardSelection([invoice]));
      return (
        <>
          <ForwardAttachmentPicker files={[invoice]} pictures={[]} internal={[note]} value={value} onChange={setValue} />
          <output data-testid="ids">{forwardAttachmentIds(value, [invoice, note]).join(',')}</output>
        </>
      );
    }
    render(<WithInternal />);
    expect(screen.getByTestId('ids')).toHaveTextContent('12');
    expect(screen.queryByRole('checkbox', { name: 'Include internal-screenshot.png' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'From internal notes (1)' }));
    expect(screen.getByText(/Only your team has seen these/)).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: 'Include internal-screenshot.png' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(screen.getByTestId('ids')).toHaveTextContent('12,30');
  });

  test('nothing to offer: nothing rendered', () => {
    const { container } = render(<ForwardAttachmentPicker files={[]} pictures={[]} value={{ include: false, ids: [] }} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
