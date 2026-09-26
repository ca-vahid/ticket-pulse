/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DEFAULT_COLUMN_KEYS, QUEUE_COLUMN_MAP, normalizeColumnKeys, reopenedLabel } from './queueColumns';
import { QueueStatePill } from './ticketUi';

// QA 09-25 #1 — "Re-opened" state + optional Reopened column.

afterEach(cleanup);

const DAY = 24 * 3600 * 1000;
const ctx = {
  cell: (k) => `cell-${k}`,
  cellStyle: () => ({}),
  cellPad: 'px-2',
};

describe('Reopened column', () => {
  test('is optional, off by default, sorts server-side on reopenedAt, and survives a stored column set', () => {
    const col = QUEUE_COLUMN_MAP.get('reopened');
    expect(col.label).toBe('Reopened');
    expect(col.defaultOn).toBe(false);
    expect(col.sortField).toBe('reopenedAt');
    expect(DEFAULT_COLUMN_KEYS).not.toContain('reopened');
    expect(normalizeColumnKeys(['subject', 'requester', 'reopened'])).toEqual(['subject', 'requester', 'reopened']);
  });

  test('label: count + age, nothing for 0', () => {
    expect(reopenedLabel({ reopenCount: 2, reopenedAt: new Date(Date.now() - 3 * DAY) })).toBe('2× · 3d ago');
    expect(reopenedLabel({ reopenCount: 1, reopenedAt: null })).toBe('1×');
    expect(reopenedLabel({ reopenCount: 0, reopenedAt: new Date() })).toBeNull();
    expect(reopenedLabel({})).toBeNull();
  });

  test('renders plain text with the date in the tooltip, and a quiet dash when never reopened', () => {
    const col = QUEUE_COLUMN_MAP.get('reopened');
    const { container, rerender } = render(col.render({ reopenCount: 2, reopenedAt: new Date(Date.now() - 3 * DAY) }, ctx));
    expect(screen.getByText('2× · 3d ago')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('cell-reopened');
    expect(container.firstChild.title).toMatch(/Reopened 2 times — last on/);
    expect(container.querySelector('.rounded-full')).toBeNull(); // no pill
    rerender(col.render({ reopenCount: 0, reopenedAt: null }, ctx));
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('QueueStatePill — reopened', () => {
  test('reads "Re-opened" as amber text with an icon, not a tinted pill', () => {
    const { container } = render(<QueueStatePill state="reopened" />);
    const el = screen.getByText('Re-opened').closest('span[title]');
    expect(el).toHaveClass('text-amber-700', 'dark:text-amber-300');
    expect(el).not.toHaveClass('rounded-full');
    expect(el.className).not.toMatch(/\bbg-/);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(el.title).toMatch(/resolved or closed, came back/);
  });
});

describe('State column copy (N3)', () => {
  test('says a re-opened Pending ticket still reads "Re-opened"', async () => {
    const { STATE_COLUMN_TITLE, REOPENED_COLUMN_TITLE } = await import('./queueColumns');
    expect(STATE_COLUMN_TITLE).toMatch(/Pending\) ticket shows "—" too unless it was re-opened/);
    expect(STATE_COLUMN_TITLE).toMatch(/"Re-opened"/);
    expect(REOPENED_COLUMN_TITLE).toMatch(/Pending included/);
  });
});
