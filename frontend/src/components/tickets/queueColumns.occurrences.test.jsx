/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_COLUMN_KEYS, OccurrenceMark, QUEUE_COLUMN_MAP, normalizeColumnKeys, occurrenceTitle, occurrencesLabel } from './queueColumns';

vi.mock('../../services/api', () => ({ ticketsAPI: {} }));
const { TaskDescription } = await import('./TicketTasksTab');
const { default: AlertOccurrenceStrip } = await import('./AlertOccurrenceStrip');

// Simorgh Phase C (27 Sep 2026): rule-tuning tickets carry an occurrence count,
// a one-line "why", and tasks with the steps in their description.

afterEach(cleanup);
const HOUR = 3600 * 1000;

describe('Occurrences in the queue', () => {
  test('column is optional, off by default, sorts server-side on occurrences', () => {
    const col = QUEUE_COLUMN_MAP.get('occurrences');
    expect(col.label).toBe('Occurrences');
    expect(col.defaultOn).toBe(false);
    expect(col.sortField).toBe('occurrences');
    expect(DEFAULT_COLUMN_KEYS).not.toContain('occurrences');
    expect(normalizeColumnKeys(['subject', 'requester', 'occurrences'])).toEqual(['subject', 'requester', 'occurrences']);
  });

  test('label and tooltip: count, age and the why; nothing for ordinary tickets', () => {
    const t = { occurrenceCount: 12, lastOccurrenceAt: new Date(Date.now() - 2 * HOUR), lastOccurrenceSummary: 'signed IT tooling on bgc2744' };
    expect(occurrencesLabel(t)).toBe('12× · 2h ago');
    expect(occurrenceTitle(t)).toMatch(/^Fired 12 times — last on .+\nsigned IT tooling on bgc2744$/);
    expect(occurrencesLabel({ occurrenceCount: 0 })).toBeNull();
    expect(occurrenceTitle({ occurrenceCount: 0 })).toBeUndefined();
  });

  test('the mark beside the subject appears only once an alert has repeated', () => {
    const { container, rerender } = render(<OccurrenceMark ticket={{ occurrenceCount: 1 }} />);
    expect(container.innerHTML).toBe('');
    rerender(<OccurrenceMark ticket={{ occurrenceCount: 14 }} />);
    expect(screen.getByTestId('occurrence-mark')).toHaveTextContent('14×');
  });
});

describe('The why on the ticket page', () => {
  test('the strip shows the latest summary under the count', () => {
    render(<AlertOccurrenceStrip ticket={{ id: 0, occurrenceCount: 3, lastOccurrenceSummary: 'same persistence rule, signed IT tooling on bgc2744' }} />);
    expect(screen.getByTestId('alert-occurrence-summary')).toHaveTextContent('same persistence rule, signed IT tooling on bgc2744');
  });
});

describe('Task description', () => {
  const lf = String.fromCharCode(10);

  test('keeps line breaks and turns links into links', () => {
    render(<TaskDescription text={['Why: Rostam asked.', 'Steps: https://security.microsoft.com/x'].join(lf)} />);
    const box = screen.getByTestId('task-description');
    expect(box.firstChild).toHaveClass('whitespace-pre-line');
    expect(screen.getByRole('link', { name: 'https://security.microsoft.com/x' })).toHaveAttribute('href', 'https://security.microsoft.com/x');
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('a long description folds behind Show all', () => {
    render(<TaskDescription text={['1', '2', '3', '4', '5', '6'].join(lf)} />);
    const box = screen.getByTestId('task-description');
    expect(box.firstChild).toHaveClass('line-clamp-4');
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(box.firstChild).not.toHaveClass('line-clamp-4');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });
});
