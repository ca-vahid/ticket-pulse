/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Assetron: a hardware category asks "laptop or not?" as a real choice (29 Sep 2026).
vi.mock('./RichTextEditor', () => ({
  default: ({ ariaLabel, onChange }) => <textarea aria-label={ariaLabel || 'editor'} onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />,
  isRichContent: () => false,
}));
vi.mock('./StagedFileChip', () => ({ default: ({ file }) => <li>{file.name}</li> }));
vi.mock('./LaptopPicker', () => ({
  default: ({ recipient, onChange }) => (
    <div>
      <span>for {recipient?.email}</span>
      <button type="button" onClick={() => onChange({ id: 'asset-1', make: 'Dell', model: 'Latitude 7650' })}>stub pick</button>
    </div>
  ),
}));

import RequestApprovalModal from './RequestApprovalModal';

const categories = [
  { id: 4, name: 'New Computer Upgrade', managerEmails: ['nev@x.io'], managerCount: 1, gatesHardware: true },
  { id: 9, name: 'AI Premium License Request', managerEmails: ['bob@x.io'], managerCount: 1 },
];
const requester = { name: 'Rita', email: 'Rita@X.io' };
const send = () => screen.getByRole('button', { name: /Send approval request/ });

describe('RequestApprovalModal — Assetron laptop choice', () => {
  afterEach(() => cleanup());

  test('only a hardware category asks; the requester is the default recipient', () => {
    const { unmount } = render(<RequestApprovalModal categories={[categories[1]]} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('radiogroup', { name: 'Laptop' })).not.toBeInTheDocument();
    unmount();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Reserve a laptop from Assetron/ }));
    expect(screen.getByText('for rita@x.io')).toBeInTheDocument();
  });

  test('nothing is sent until the agent chooses; "No laptop" sends without one (a charger request)', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.getByText('Choose one to continue.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /No laptop/ }));
    expect(screen.getByRole('radio', { name: /No laptop/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalCategoryId: 4, hardware: null }));
  });

  test('Assetron chosen: blocked until a laptop is picked, then the laptop and recipient are sent', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Reserve a laptop from Assetron/ }));
    fireEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('stub pick'));
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      hardware: { assetId: 'asset-1', recipient: { email: 'rita@x.io', name: 'Rita' } },
    }));
  });
});
