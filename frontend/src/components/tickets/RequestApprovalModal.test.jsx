/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// QA 08-11 #4: the "approvals stay inside Ticket Pulse" note must show ALWAYS —
// it used to render only once a category was selected.

vi.mock('./RichTextEditor', () => ({
  default: ({ ariaLabel, onChange }) => <textarea aria-label={ariaLabel || 'editor'} onChange={(e) => onChange?.({ html: `<p>${e.target.value}</p>`, text: e.target.value })} />,
  isRichContent: () => false,
}));
vi.mock('./StagedFileChip', () => ({ default: ({ file }) => <li>{file.name}</li> }));

import RequestApprovalModal from './RequestApprovalModal';

const categories = [
  { id: 1, name: 'Hardware purchase', managerEmails: ['alice@x.io'], managerCount: 1 },
  { id: 2, name: 'Software licence', managerEmails: ['bob@x.io'], managerCount: 1 },
];

describe('RequestApprovalModal TP-only note (QA 08-11 #4)', () => {
  afterEach(() => cleanup());

  test('the TP-only note is visible BEFORE any category is selected', () => {
    render(<RequestApprovalModal categories={categories} onSubmit={vi.fn()} onClose={vi.fn()} />);
    // Two categories → nothing auto-selected, so this proves pre-selection visibility.
    expect(screen.getByText(/never synced to FreshService/i)).toBeInTheDocument();
    expect(screen.getByText(/Approvals stay inside Ticket Pulse/i)).toBeInTheDocument();
    // The per-category count sentence still waits for a selection.
    expect(screen.queryByText(/The first to respond decides/i)).not.toBeInTheDocument();
  });

  test('the note stays visible after selecting a category (with the count sentence)', () => {
    render(<RequestApprovalModal categories={categories} onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Hardware purchase'));
    expect(screen.getByText(/never synced to FreshService/i)).toBeInTheDocument();
    expect(screen.getByText(/The first to respond decides/i)).toBeInTheDocument();
  });
});

// Approvals v2 (09-15 #8): searchable picker, amount + tier read-out, files.
const tiered = [
  ...categories,
  {
    id: 3, name: 'Security', description: 'Perimeter changes', managerCount: 1, managerEmails: ['vahid@x.io'],
    hasAmount: true, amountCurrency: 'CAD', tierCount: 2,
    tiers: [{ name: 'Tier 1', managerEmails: ['vahid@x.io'], limit: 5000 }, { name: 'Tier 2', managerEmails: ['neville@x.io'], limit: null }],
  },
];
const techs = [{ id: 1, name: 'Vahid Haeri', email: 'vahid@x.io' }, { id: 2, name: 'Neville Howell', email: 'neville@x.io' }];

describe('RequestApprovalModal — Approvals v2', () => {
  afterEach(() => cleanup());

  test('the picker filters as you type and rows show the tier chain', () => {
    render(<RequestApprovalModal categories={tiered} technicians={techs} onSubmit={vi.fn()} onClose={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: 'Approval category' });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.change(box, { target: { value: 'sec' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Security/ })).toHaveTextContent(/Vahid.*Tier 1.*up to \$5,000\.00.*Neville.*Tier 2/);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(/No categories match/)).toBeInTheDocument();
  });

  test('a monetary category needs an amount; the read-out names who finalises', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={tiered} technicians={techs} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('option', { name: /Security/ }));
    const amount = screen.getByLabelText(/Amount/);
    // Submitting without an amount is refused.
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter the amount/);

    fireEvent.change(amount, { target: { value: '4000' } });
    expect(screen.getByText(/can be approved by/)).toHaveTextContent(/\$4,000\.00 can be approved by Vahid Haeri/);
    fireEvent.change(amount, { target: { value: '6000' } });
    expect(screen.getByText(/is over the Tier 1 limit/)).toHaveTextContent(/after Vahid Haeri approves, it goes on to Neville Howell \(Tier 2\) automatically/);

    fireEvent.change(screen.getByRole('textbox', { name: 'Approval context' }), { target: { value: 'Firewall renewal' } });
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalCategoryId: 3, amount: 6000, note: 'Firewall renewal', notifyApprover: true, files: [] }));
  });

  test('dropped files are staged and travel in the payload; "Change" reopens the picker', () => {
    const onSubmit = vi.fn();
    render(<RequestApprovalModal categories={tiered} technicians={techs} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('option', { name: /Hardware purchase/ }));
    const file = new File(['x'], 'quote.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('textbox', { name: 'Approval context' }), { dataTransfer: { files: [file] } });
    expect(screen.getByRole('list', { name: 'Files to attach' })).toHaveTextContent('quote.png');
    fireEvent.click(screen.getByRole('button', { name: /Send approval request/ }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ approvalCategoryId: 1, amount: null, files: [file] }));
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('combobox', { name: 'Approval category' })).toBeInTheDocument();
  });
});
