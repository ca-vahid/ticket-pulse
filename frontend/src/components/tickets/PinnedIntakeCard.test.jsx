/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const dismissPinnedCard = vi.fn(() => Promise.resolve({ data: { ok: true } }));
vi.mock('../../services/api', () => ({
  ticketsAPI: { dismissPinnedCard: (...args) => dismissPinnedCard(...args) },
}));

import PinnedIntakeCard, { PinnedCardChipsRow } from './PinnedIntakeCard';

// Contract: ticket.pinnedCards = [{ id, kind:'field_card', payload, createdAt }]
const CARD = {
  id: 'card-1',
  kind: 'field_card',
  createdAt: '2026-08-06T09:00:00Z',
  payload: {
    kind: 'field_card',
    v: 1,
    title: 'Intake details',
    intro: null,
    accent: 'blue',
    workflowId: 9,
    runId: 77,
    workflowName: 'API intake router',
    fields: [
      { key: 'client_name', label: 'Client name', type: 'text', value: 'Acme Corp' },
      { key: 'expedite', label: 'Expedite', type: 'boolean', value: false },
    ],
  },
};

describe('PinnedIntakeCard', () => {
  beforeEach(() => {
    dismissPinnedCard.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
  });
  afterEach(() => cleanup());

  test('renders the compact card with title, workflow chip and field chips', () => {
    render(<PinnedIntakeCard ticketId={501} cards={[CARD]} canDismiss />);
    expect(screen.getByTestId('pinned-intake-card')).toBeInTheDocument();
    expect(screen.getByText('Intake details')).toBeInTheDocument();
    expect(screen.getByText('via API intake router')).toBeInTheDocument();
    expect(screen.getByText('Client name:')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  test('renders nothing when there are no active cards', () => {
    const { container } = render(<PinnedIntakeCard ticketId={501} cards={[]} canDismiss />);
    expect(container).toBeEmptyDOMElement();
  });

  test('dismiss asks first, then calls the API and hides the card optimistically', async () => {
    const onDismissed = vi.fn();
    render(<PinnedIntakeCard ticketId={501} cards={[CARD]} canDismiss onDismissed={onDismissed} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card' }));
    expect(screen.getByRole('dialog', { name: 'Confirm dismiss' })).toHaveTextContent(
      "Dismiss this card? It won't return unless the workflow runs again.",
    );

    // Keep → nothing happens.
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(dismissPinnedCard).not.toHaveBeenCalled();
    expect(screen.getByTestId('pinned-intake-card')).toBeInTheDocument();

    // Confirm → optimistic removal + API call.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('pinned-intake-card')).not.toBeInTheDocument();
    expect(dismissPinnedCard).toHaveBeenCalledWith(501, 'card-1');
    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith(CARD));
  });

  test('a failed dismiss brings the card back with an error line', async () => {
    dismissPinnedCard.mockRejectedValueOnce(new Error('boom'));
    render(<PinnedIntakeCard ticketId={501} cards={[CARD]} canDismiss />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByTestId('pinned-intake-card')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  test('without dismiss rights there is no ✕ at all', () => {
    render(<PinnedIntakeCard ticketId={501} cards={[CARD]} />);
    expect(screen.queryByRole('button', { name: 'Dismiss card' })).not.toBeInTheDocument();
  });

  test('live values overlay onto the chips', () => {
    render(<PinnedIntakeCard ticketId={501} cards={[CARD]} currentValues={{ client_name: 'Acme Corp Ltd' }} />);
    expect(screen.getByText('Acme Corp Ltd')).toHaveAttribute('title', 'Updated since this note — was: Acme Corp');
  });
});

describe('PinnedCardChipsRow (peek preview Details)', () => {
  afterEach(() => cleanup());

  test('renders chips only — no dismiss, no edit affordances', () => {
    render(<PinnedCardChipsRow cards={[CARD]} />);
    expect(screen.getByTestId('pinned-card-chips-row')).toBeInTheDocument();
    expect(screen.getByText('Workflow card')).toBeInTheDocument();
    expect(screen.getByText('Client name:')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  test('renders nothing without field-card entries', () => {
    const { container } = render(<PinnedCardChipsRow cards={[{ id: 'x', kind: 'other', payload: {} }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
