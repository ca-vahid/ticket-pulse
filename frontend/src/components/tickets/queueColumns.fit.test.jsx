/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_COLUMN_KEYS, QueueColumnsMenu } from './queueColumns';

// 17 Oct 2026 (Vahid): on a short window the Columns menu ran off the screen,
// so its switches were out of reach; and the Subject column's freeze is now a
// personal switch, on by default.

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const open = (props = {}) => {
  render(<QueueColumnsMenu value={DEFAULT_COLUMN_KEYS} onChange={() => {}} onResetWidths={() => {}} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /columns/i }));
};

describe('Columns menu — fits the window', () => {
  test('capped to the room under the button; the column list shrinks first', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 460, bottom: 508, left: 0, right: 100, width: 100, height: 48 });
    window.innerHeight = 900;
    open({ onSideArrowsChange: () => {} });
    const menu = screen.getByTestId('columns-menu');
    expect(menu).toHaveStyle({ maxHeight: '380px' }); // 900 - 508 - 12
    expect(menu.className).toContain('overflow-y-auto');
    expect(menu.querySelector('ul').className).toContain('flex-1');
    // the switch stays outside the shrinking list
    expect(menu.querySelector('ul').contains(screen.getByRole('switch', { name: /scroll arrows/i }))).toBe(false);
  });
});

describe('Columns menu — Keep Subject in place', () => {
  test('on by default and reports a toggle', () => {
    const onFreezeSubjectChange = vi.fn();
    open({ onFreezeSubjectChange });
    const sw = screen.getByRole('switch', { name: /keep subject in place/i });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    expect(onFreezeSubjectChange).toHaveBeenCalledWith(false);
  });

  test('shows the saved choice; absent when the page does not offer it', () => {
    open({ onFreezeSubjectChange: () => {}, freezeSubject: false });
    expect(screen.getByRole('switch', { name: /keep subject in place/i })).not.toBeChecked();
    cleanup();
    open();
    expect(screen.queryByRole('switch', { name: /keep subject in place/i })).toBeNull();
  });
});
