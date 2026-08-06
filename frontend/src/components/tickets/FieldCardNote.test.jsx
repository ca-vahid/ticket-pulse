/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FieldCardNote, { CF_FILTERING_ENABLED, FieldValueChip } from './FieldCardNote';
import { formatDayTime } from './ticketUi';

// Contract (custom-fields activation Phase 1): thread entries whose
// rawPayload.kind === 'field_card' carry { v, title, intro, accent,
// fields:[{key,label,type,value}], workflowId, runId, workflowName }.
const ENTRY = {
  id: 9101,
  authorType: 'system',
  isPrivate: true,
  eventType: 'note',
  occurredAt: '2026-08-06T10:00:00Z',
  rawPayload: {
    kind: 'field_card',
    v: 1,
    title: 'Intake details',
    intro: 'Captured from the Power App submission.',
    accent: 'emerald',
    workflowId: 9,
    runId: 77,
    workflowName: 'API intake router',
    fields: [
      { key: 'client_name', label: 'Client name', type: 'text', value: 'Acme Corp' },
      { key: 'record_link', label: 'Record link', type: 'text', value: 'https://example.sharepoint.com/items/1042' },
      { key: 'expedite', label: 'Expedite', type: 'boolean', value: true },
      { key: 'needed_by', label: 'Needed by', type: 'date', value: '2026-08-10T17:00:00Z' },
    ],
  },
};

const writeText = vi.fn(() => Promise.resolve());

function renderCard(props = {}) {
  return render(
    <ul>
      <FieldCardNote entry={ENTRY} {...props} />
    </ul>,
  );
}

describe('FieldCardNote', () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => cleanup());

  test('renders title, intro and the via-workflow chip', () => {
    renderCard();
    expect(screen.getByTestId('field-card-note')).toBeInTheDocument();
    expect(screen.getByText('Intake details')).toBeInTheDocument();
    expect(screen.getByText('Captured from the Power App submission.')).toBeInTheDocument();
    expect(screen.getByText('via API intake router · Auto')).toBeInTheDocument();
  });

  test('falls back to "Ticket details" when the payload has no title', () => {
    render(
      <ul>
        <FieldCardNote entry={{ ...ENTRY, rawPayload: { ...ENTRY.rawPayload, title: null, workflowName: null } }} />
      </ul>,
    );
    expect(screen.getByText('Ticket details')).toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  test('click-to-copy chip copies the value and notifies', async () => {
    const onCopied = vi.fn();
    renderCard({ onCopied });
    fireEvent.click(screen.getByRole('button', { name: 'Acme Corp' }));
    await screen.findByTitle('Copied');
    expect(writeText).toHaveBeenCalledWith('Acme Corp');
    expect(onCopied).toHaveBeenCalled();
  });

  test('URL values render as truncated external links', () => {
    renderCard();
    const link = screen.getByRole('link', { name: 'Record link (opens in a new tab)' });
    expect(link).toHaveAttribute('href', 'https://example.sharepoint.com/items/1042');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link).toHaveAttribute('title', 'https://example.sharepoint.com/items/1042');
    expect(link).toHaveTextContent('example.sharepoint.com/items/1042');
  });

  test('boolean values render as a Yes/No pill; dates via formatDayTime', () => {
    renderCard();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText(formatDayTime('2026-08-10T17:00:00Z'))).toBeInTheDocument();
  });

  test('pencil scrolls to the right-rail editor via onEditField(key)', () => {
    const onEditField = vi.fn();
    renderCard({ onEditField });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Client name' }));
    expect(onEditField).toHaveBeenCalledWith('client_name');
  });

  test('live-value overlay shows the CURRENT value with the snapshot in the tooltip', () => {
    renderCard({ currentValues: { client_name: 'Acme Corp (renamed)', expedite: true } });
    const updated = screen.getByText('Acme Corp (renamed)');
    expect(updated).toHaveAttribute('title', 'Updated since this note — was: Acme Corp');
    expect(updated).toHaveAttribute('data-changed', 'true');
    expect(updated.className).toContain('decoration-dashed');
    // Unchanged fields keep the snapshot with no overlay.
    expect(screen.getByText('Yes')).not.toHaveAttribute('data-changed');
    expect(screen.queryByText('Acme Corp')).not.toBeInTheDocument();
  });

  test('snapshot stays authoritative when no current values are supplied (builder preview)', () => {
    renderCard();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  test('"Filter queue by this value" stays feature-flagged off until Phase 2', () => {
    expect(CF_FILTERING_ENABLED).toBe(false);
    renderCard();
    expect(screen.queryByRole('button', { name: /Filter queue by/ })).not.toBeInTheDocument();
  });

  test('empty values render an em dash without a copy affordance', () => {
    render(
      <ul>
        <li>
          <FieldValueChip field={{ key: 'po_number', label: 'PO number', type: 'text', value: '' }} />
        </li>
      </ul>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
