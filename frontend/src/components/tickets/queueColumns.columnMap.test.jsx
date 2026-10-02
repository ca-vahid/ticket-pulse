/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_COLUMN_KEYS, QueueColumnsMenu } from './queueColumns';

// 2 Oct 2026 — the column map over the wide list is a personal opt-in in the
// Columns menu, off by default.

afterEach(cleanup);

describe('Columns menu — column map switch', () => {
  test('shows the switch off by default and reports a toggle', () => {
    const onColumnMapChange = vi.fn();
    render(<QueueColumnsMenu value={DEFAULT_COLUMN_KEYS} onChange={() => {}} onResetWidths={() => {}} onColumnMapChange={onColumnMapChange} />);
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const sw = screen.getByRole('switch', { name: /column map/i });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    expect(onColumnMapChange).toHaveBeenCalledWith(true);
  });

  test('no switch when the page does not offer one', () => {
    render(<QueueColumnsMenu value={DEFAULT_COLUMN_KEYS} onChange={() => {}} onResetWidths={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    expect(screen.queryByRole('switch', { name: /column map/i })).toBeNull();
  });
});
