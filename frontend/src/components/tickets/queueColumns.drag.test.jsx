/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueueColumnsMenu, QUEUE_COLUMN_MAP } from './queueColumns';

/**
 * QA 09-17 #3 — "when trying to move columns around, we need to be able to
 * drag by the whole row not just the 6 dots". The row is the drag source now;
 * the grip keeps the cursor affordance and the Alt+↑/↓ keyboard handle.
 */

afterEach(cleanup);

const KEYS = ['subject', 'status', 'priority'];

function renderMenu(onChange = vi.fn()) {
  render(<QueueColumnsMenu value={KEYS} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /Columns/ }));
  return onChange;
}

/** The <li> that owns a column's label. */
function rowFor(key) {
  const label = QUEUE_COLUMN_MAP.get(key).label;
  return screen.getByText(label).closest('li');
}

/** Minimal dataTransfer stub — jsdom gives drag events none. */
const dt = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') });

describe('QueueColumnsMenu — whole-row drag', () => {
  test('every row is draggable, not just its grip', () => {
    renderMenu();
    for (const key of KEYS) expect(rowFor(key)).toHaveAttribute('draggable', 'true');
  });

  test('the grip is no longer its own drag source', () => {
    renderMenu();
    const grip = screen.getByRole('button', { name: /Reorder Status column/ });
    expect(grip).not.toHaveAttribute('draggable');
  });

  test('dragging a row onto another reorders the columns', () => {
    const onChange = renderMenu();

    // Subject (first) dropped onto Priority (last). jsdom reports a zero-height
    // box for every row, so the pointer always reads as below the midpoint and
    // the drop lands AFTER the target — Subject goes to the end.
    fireEvent.dragStart(rowFor('subject'), { dataTransfer: dt() });
    fireEvent.dragOver(rowFor('priority'), { dataTransfer: dt(), clientY: 10 });
    fireEvent.drop(rowFor('priority'), { dataTransfer: dt() });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(['status', 'priority', 'subject']);
  });

  test('the checkbox still toggles and is not a drag source', () => {
    const onChange = renderMenu();
    const checkbox = screen.getByRole('checkbox', { name: 'Status column' });
    expect(checkbox).toHaveAttribute('draggable', 'false');
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).not.toContain('status');
  });

  test('Alt+arrow on the grip still moves a column with the keyboard', () => {
    const onChange = renderMenu();
    fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Priority column/ }), { key: 'ArrowUp', altKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(['subject', 'priority', 'status']);
  });
});
