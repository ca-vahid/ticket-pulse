/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Approval redesign (B1 + C1, 29 Sep 2026): a hardware category adds a Hardware
// step — "Reserve from Assetron" (device finder) or "Manual entry".
vi.mock('./RichTextEditor', () => ({
  default: ({ ariaLabel, onChange }) => <textarea aria-label={ariaLabel || 'editor'} onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />,
  isRichContent: () => false,
}));
vi.mock('./StagedFileChip', () => ({ default: ({ file }) => <li>{file.name}</li> }));
vi.mock('./LaptopPicker', () => ({
  assetTitle: (a) => [a?.make, a?.model].filter(Boolean).join(' '),
  default: ({ recipient, onChange, onLoaded }) => (
    <div>
      <span>for {recipient?.email}</span>
      <button type="button" onClick={() => onLoaded?.(12)}>stub loaded</button>
      <button type="button" onClick={() => onChange({ id: 'asset-1', make: 'Dell', model: 'Pro 16', serialNumber: 'SN1' })}>stub pick</button>
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

describe('RequestApprovalModal — steps and the hardware choice', () => {
  afterEach(() => cleanup());

  test('picking a category moves on: What → Details, or What → Hardware → Details for hardware', () => {
    render(<RequestApprovalModal categories={categories} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent(/What.*Details/);
    fireEvent.click(screen.getByRole('option', { name: /AI Premium License Request/ }));
    expect(screen.queryByTestId('hardware-step')).toBeNull();
    expect(send()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('option', { name: /New Computer Upgrade/ }));
    expect(screen.getByRole('list', { name: 'Steps' })).toHaveTextContent(/What.*Hardware.*Details/);
    expect(screen.getByTestId('hardware-step')).toBeInTheDocument();
  });

  test('Next stays off until a source is chosen and complete', () => {
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Choose one to continue.')).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Reserve from Assetron/ }));
    expect(screen.getByText('for rita@x.io')).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByText('stub loaded'));
    expect(screen.getByRole('radio', { name: /Reserve from Assetron/ })).toHaveTextContent('12 new devices available');
    fireEvent.click(screen.getByText('stub pick'));
    expect(next()).toBeEnabled();
  });

  test('Assetron: the device and recipient are sent; the details step shows what is held', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Reserve from Assetron/ }));
    fireEvent.click(screen.getByText('stub pick'));
    fireEvent.click(next());
    expect(screen.getByTestId('hardware-summary')).toHaveTextContent(/Dell Pro 16.*SN1.*held in Assetron for Rita/);
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      approvalCategoryId: 4,
      hardware: { assetId: 'asset-1', recipient: { email: 'rita@x.io', name: 'Rita' } },
    }));
  });

  test('Manual entry: nothing reserved; what and how many lead the request note', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Manual entry/ }));
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What is needed/), { target: { value: 'USB-C charger 100 W' } });
    fireEvent.change(screen.getByLabelText(/Quantity/), { target: { value: '2' } });
    fireEvent.click(next());
    expect(screen.getByTestId('hardware-summary')).toHaveTextContent('Manual entry: 2 × USB-C charger 100 W');
    fireEvent.change(screen.getByRole('textbox', { name: 'Approval context' }), { target: { value: 'For the Calgary field kit' } });
    fireEvent.click(send());
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.hardware).toBeNull();
    expect(payload.note.startsWith('Hardware (manual entry): 2 × USB-C charger 100 W')).toBe(true);
    expect(payload.note.endsWith('For the Calgary field kit')).toBe(true);
  });
});
