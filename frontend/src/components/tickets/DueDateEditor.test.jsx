/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DueDateEditor, { duePresets } from './DueDateEditor';

// Wednesday, Aug 5 2026, 10:00 local — presets resolve relative to "now".
const NOW = new Date(2026, 7, 5, 10, 0, 0);

describe('duePresets (QA 08-04 #13 — FS-style preset targets, 11:59 PM local)', () => {
  test('resolves Today / Tomorrow / This week (Sat) / Next week / This month', () => {
    const presets = duePresets(NOW);
    expect(presets.map((p) => p.label)).toEqual(['Today', 'Tomorrow', 'This week', 'Next week', 'This month']);
    expect(presets[0].date).toEqual(new Date(2026, 7, 5, 23, 59, 0, 0)); // Wed Aug 5
    expect(presets[1].date).toEqual(new Date(2026, 7, 6, 23, 59, 0, 0)); // Thu Aug 6
    expect(presets[2].date).toEqual(new Date(2026, 7, 8, 23, 59, 0, 0)); // Sat Aug 8
    expect(presets[3].date).toEqual(new Date(2026, 7, 15, 23, 59, 0, 0)); // Sat Aug 15
    expect(presets[4].date).toEqual(new Date(2026, 7, 31, 23, 59, 0, 0)); // Mon Aug 31
  });

  test('on a Saturday, "This week" is today and "Next week" the following Saturday', () => {
    const sat = new Date(2026, 7, 8, 9, 0, 0);
    const presets = duePresets(sat);
    expect(presets[2].date).toEqual(new Date(2026, 7, 8, 23, 59, 0, 0));
    expect(presets[3].date).toEqual(new Date(2026, 7, 15, 23, 59, 0, 0));
  });

  test('month boundary: "This month" on the last day is still that day', () => {
    const eom = new Date(2026, 7, 31, 9, 0, 0);
    expect(duePresets(eom)[4].date).toEqual(new Date(2026, 7, 31, 23, 59, 0, 0));
  });
});

describe('DueDateEditor popover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  const open = () => fireEvent.click(screen.getByRole('button', { name: /edit resolution due date/i }));

  test('pencil opens the preset menu with each row showing its resolved datetime', () => {
    render(<DueDateEditor label="Resolution" value={null} onSave={vi.fn()} />);
    open();
    expect(screen.getByRole('dialog', { name: /set resolution due date/i })).toBeInTheDocument();
    // Tomorrow row carries the resolved Thu Aug 6, 11:59 PM datetime.
    const tomorrow = screen.getByRole('button', { name: /tomorrow/i });
    const expected = new Date(2026, 7, 6, 23, 59);
    expect(tomorrow.textContent).toContain(
      expected.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
  });

  test('choosing a preset saves its ISO datetime (the PUT payload value)', () => {
    const onSave = vi.fn();
    render(<DueDateEditor label="Resolution" value={null} onSave={onSave} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /this week/i }));
    expect(onSave).toHaveBeenCalledWith(new Date(2026, 7, 8, 23, 59, 0, 0).toISOString());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // closes after choosing
  });

  test('"Pick date and time" expands a datetime-local input; Set saves its ISO', () => {
    const onSave = vi.fn();
    render(<DueDateEditor label="Resolution" value={null} onSave={onSave} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: /pick date and time/i }));
    const input = screen.getByLabelText(/custom resolution due date and time/i);
    fireEvent.change(input, { target: { value: '2026-09-01T14:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(onSave).toHaveBeenCalledWith(new Date(2026, 8, 1, 14, 30).toISOString());
  });

  test('"Remove due date" clears with null — and only offers itself when a date is set', () => {
    const onSave = vi.fn();
    const { unmount } = render(
      <DueDateEditor label="Resolution" value="2026-08-06T23:59:00.000Z" onSave={onSave} />,
    );
    open();
    fireEvent.click(screen.getByRole('button', { name: /remove due date/i }));
    expect(onSave).toHaveBeenCalledWith(null);
    unmount();

    render(<DueDateEditor label="Resolution" value={null} onSave={vi.fn()} />);
    open();
    expect(screen.queryByRole('button', { name: /remove due date/i })).not.toBeInTheDocument();
  });

  test('Escape closes the popover without saving', () => {
    const onSave = vi.fn();
    render(<DueDateEditor label="Resolution" value={null} onSave={onSave} />);
    open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
