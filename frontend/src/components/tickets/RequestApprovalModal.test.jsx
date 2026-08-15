/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// QA 08-11 #4: the "approvals stay inside Ticket Pulse" note must show ALWAYS —
// it used to render only once a category was selected.

vi.mock('./RichTextEditor', () => ({
  default: ({ ariaLabel }) => <textarea aria-label={ariaLabel || 'editor'} />,
  isRichContent: () => false,
}));

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
