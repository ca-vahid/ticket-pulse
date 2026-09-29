/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Approval redesign (29 Sep 2026): a hardware category adds a Hardware step
// with up to 5 items — each "Reserve from Assetron" (device finder) or
// "Manual entry" (a full editor; pasted lists and tables welcome).
vi.mock('./RichTextEditor', () => ({
  default: ({ ariaLabel, onChange }) => <textarea aria-label={ariaLabel || 'editor'} onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />,
  isRichContent: (h) => typeof h === 'string' && h.includes('<'),
}));
vi.mock('./StagedFileChip', () => ({ default: ({ file }) => <li>{file.name}</li> }));
let pickSeq = 0;
vi.mock('./LaptopPicker', () => ({
  assetTitle: (a) => [a?.make, a?.model].filter(Boolean).join(' '),
  RecipientField: ({ recipient }) => <span>for {recipient?.email}</span>,
  default: ({ onChange, onLoaded, excludeIds }) => (
    <div>
      <span data-testid="excluded">{(excludeIds || []).join(',')}</span>
      <button type="button" onClick={() => onLoaded?.(12)}>stub loaded</button>
      <button type="button" onClick={() => { pickSeq += 1; onChange({ id: `asset-${pickSeq}`, make: 'Dell', model: 'Pro 16', serialNumber: `SN${pickSeq}` }); }}>stub pick</button>
    </div>
  ),
}));

import RequestApprovalModal from './RequestApprovalModal';

const categories = [
  { id: 4, name: 'New Computer Upgrade', managerEmails: ['nev@x.io'], managerCount: 1, gatesHardware: true },
  { id: 9, name: 'AI Premium License Request', managerEmails: ['bob@x.io'], managerCount: 1 },
];
const requester = { name: 'Rita', email: 'Rita@X.io' };
const next = () => screen.getByRole('button', { name: /Next/ });
const send = () => screen.getByRole('button', { name: /Send approval request/ });
const items = () => screen.getAllByTestId('hardware-item');
const openHw = (onSubmit = vi.fn()) => render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);

describe('RequestApprovalModal — steps and hardware items', () => {
  afterEach(() => { cleanup(); pickSeq = 0; });

  test('picking a category moves on: What → Details, or What → Hardware → Details for hardware', () => {
    render(<RequestApprovalModal categories={categories} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent(/What.*Details/);
    fireEvent.click(screen.getByRole('option', { name: /AI Premium License Request/ }));
    expect(screen.queryByTestId('hardware-step')).toBeNull();
    expect(send()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('option', { name: /New Computer Upgrade/ }));
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent(/What.*Hardware.*Details/);
    expect(items()).toHaveLength(1);
  });

  test('Next stays off until every item is complete; the recipient shows once for Assetron items', () => {
    openHw();
    expect(next()).toBeDisabled();
    fireEvent.click(within(items()[0]).getByRole('radio', { name: /Reserve from Assetron/ }));
    expect(screen.getByText('for rita@x.io')).toBeInTheDocument();
    fireEvent.click(screen.getByText('stub loaded'));
    expect(within(items()[0]).getByRole('radio', { name: /Reserve from Assetron/ })).toHaveTextContent('12 new devices available');
    fireEvent.click(screen.getByText('stub pick'));
    expect(next()).toBeEnabled();
    fireEvent.click(screen.getByTestId('add-hardware'));
    expect(items()).toHaveLength(2);
    expect(next()).toBeDisabled();
  });

  test('a device and a manual item together: the device is reserved, the manual item leads the note', () => {
    const onSubmit = vi.fn();
    openHw(onSubmit);
    fireEvent.click(within(items()[0]).getByRole('radio', { name: /Reserve from Assetron/ }));
    fireEvent.click(screen.getByText('stub pick'));
    fireEvent.click(screen.getByTestId('add-hardware'));
    const second = items()[1];
    fireEvent.click(within(second).getByRole('radio', { name: /Manual entry/ }));
    fireEvent.change(within(second).getByRole('textbox', { name: 'Hardware item 2' }), { target: { value: 'USB-C dock and two 27-inch monitors' } });
    fireEvent.click(next());
    expect(screen.getByTestId('hardware-summary')).toHaveTextContent(/1\..*Dell Pro 16.*SN1.*held in Assetron for Rita.*2\..*Manual entry: USB-C dock and two 27-inch monitors/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Approval context' }), { target: { value: 'New hire in Calgary' } });
    fireEvent.click(send());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.hardware).toEqual([{ assetId: 'asset-1', recipient: { email: 'rita@x.io', name: 'Rita' } }]);
    expect(payload.note.startsWith('Hardware requested (manual entry):')).toBe(true);
    expect(payload.note).toContain('USB-C dock and two 27-inch monitors');
    expect(payload.note.endsWith('New hire in Calgary')).toBe(true);
    expect(payload.noteHtml).toContain('<strong>Hardware requested (manual entry)</strong>');
    expect(payload.noteHtml).toContain('<p>USB-C dock and two 27-inch monitors</p>');
  });

  test('two devices: each item hides the device picked on the other; both are sent', () => {
    const onSubmit = vi.fn();
    openHw(onSubmit);
    fireEvent.click(within(items()[0]).getByRole('radio', { name: /Reserve from Assetron/ }));
    fireEvent.click(screen.getByText('stub pick'));
    fireEvent.click(screen.getByTestId('add-hardware'));
    fireEvent.click(within(items()[1]).getByRole('radio', { name: /Reserve from Assetron/ }));
    expect(within(items()[1]).getByTestId('excluded')).toHaveTextContent('asset-1');
    fireEvent.click(within(items()[1]).getByText('stub pick'));
    fireEvent.click(next());
    fireEvent.click(send());
    expect(onSubmit.mock.calls[0][0].hardware.map((h) => h.assetId)).toEqual(['asset-1', 'asset-2']);
  });

  test('up to 5 items; − removes one', () => {
    openHw();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByTestId('add-hardware'));
    expect(items()).toHaveLength(5);
    expect(screen.queryByTestId('add-hardware')).toBeNull();
    expect(screen.getByText('Up to 5 items on one request.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 3' }));
    expect(items()).toHaveLength(4);
    expect(screen.getByTestId('add-hardware')).toBeInTheDocument();
  });
});
