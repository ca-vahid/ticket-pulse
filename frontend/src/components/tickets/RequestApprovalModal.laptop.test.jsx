/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Assetron (24 Sep 2026): a hardware category offers an OPTIONAL laptop hold.
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

describe('RequestApprovalModal — Assetron laptop', () => {
  afterEach(() => cleanup());

  test('only a hardware category offers the laptop; the requester is the default recipient', () => {
    const { unmount } = render(<RequestApprovalModal categories={[categories[1]]} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByText(/Reserve a new laptop from Assetron/)).not.toBeInTheDocument();
    unmount();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Reserve a new laptop from Assetron/));
    expect(screen.getByText('for rita@x.io')).toBeInTheDocument();
  });

  test('without the box ticked no laptop is sent (a charger request)', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalCategoryId: 4, hardware: null }));
  });

  test('box ticked: blocked until a laptop is picked, then the laptop and recipient are sent', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={[categories[0]]} requester={requester} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Reserve a new laptop from Assetron/));
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('stub pick'));
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      hardware: { assetId: 'asset-1', recipient: { email: 'rita@x.io', name: 'Rita' } },
    }));
  });
});
