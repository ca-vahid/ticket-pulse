/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import LiveUpdatePill from './LiveUpdatePill';

// v3.8.31: the count moved INTO the text run. The old badge was perched on an
// inbox icon with a negative offset, so at "99+" it cleared the pill's rounded
// edge and floated outside it (QA: "the number of tickets is outside of the
// container box"). These guard the shape, not the styling.

afterEach(cleanup);

describe('LiveUpdatePill', () => {
  test('idle: refresh icon + count + "new", and nothing is absolutely positioned', () => {
    const { container } = render(<LiveUpdatePill count={12} state="idle" onApply={() => {}} />);
    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/^12\s*new/);
    // No escapee: every descendant is in flow.
    container.querySelectorAll('span, svg').forEach((el) => {
      expect(el.className.baseVal ?? el.className).not.toMatch(/absolute|-top-|-right-/);
    });
    expect(button).toBeEnabled();
  });

  test('the zero-height rail does not squash the pill (QA 09-05)', () => {
    // The rail is `h-0` so it takes no layout space. Without `items-start` the button is a flex
    // item stretched to that zero height: `box-sizing: border-box` then eats its own padding and
    // the pill renders 20 px tall instead of 41. jsdom does no layout, so the class is the guard.
    const { container } = render(<LiveUpdatePill count={3} state="idle" onApply={() => {}} />);
    const rail = container.firstChild;
    expect(rail.className).toContain('h-0');
    expect(rail.className).toContain('items-start');
  });

  test('caps at 99+ and keeps the true number for screen readers', () => {
    render(<LiveUpdatePill count={412} state="idle" onApply={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/99\+\s*new/);
    expect(screen.getByRole('status')).toHaveTextContent('412 ticket updates available');
  });

  test('one update reads in the singular for screen readers', () => {
    render(<LiveUpdatePill count={1} state="idle" onApply={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^1\s*new/);
    expect(screen.getByRole('status')).toHaveTextContent('1 ticket update available');
  });

  test('clicking applies the updates', () => {
    const onApply = vi.fn();
    render(<LiveUpdatePill count={3} state="idle" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  test('busy and done states replace the count and disable the button', () => {
    const { rerender } = render(<LiveUpdatePill count={3} state="busy" onApply={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('Refreshing…');
    expect(screen.getByRole('button')).toBeDisabled();

    rerender(<LiveUpdatePill count={3} state="done" onApply={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('Up to date');
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Ticket list is up to date');
  });

  test('stays blue-600 in both themes (the dark primary token would fail contrast on white text)', () => {
    render(<LiveUpdatePill count={5} state="idle" onApply={() => {}} />);
    const cls = screen.getByRole('button').className;
    expect(cls).toContain('bg-blue-600');
    expect(cls).toContain('text-white');
    expect(cls).not.toContain('bg-primary');
  });
});
