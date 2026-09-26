/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import PageLoadProgress, { progressOf } from './PageLoadProgress';

describe('PageLoadProgress', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  test('progressOf counts finished keys of the round', () => {
    expect(progressOf(['a', 'b', 'c', 'd', 'e'], ['d', 'e'])).toEqual({ total: 5, done: 3, pct: 60 });
    expect(progressOf([], [])).toEqual({ total: 0, done: 0, pct: 100 });
  });

  test('shows "Loading N of M · P%" from the steps, then fades out when all settle', () => {
    vi.useFakeTimers();
    const steps = (flags) => ['a', 'b', 'c', 'd', 'e'].map((key, i) => ({ key, loading: flags[i] }));
    const { rerender } = render(<PageLoadProgress steps={steps([true, true, true, true, true])} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Loading 0 of 5 · 0%');

    rerender(<PageLoadProgress steps={steps([false, true, false, true, false])} />);
    expect(screen.getByText('Loading 3 of 5 · 60%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');

    rerender(<PageLoadProgress steps={steps([false, false, false, false, false])} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  test('a later refetch starts a fresh round (1 of 1, not 4 of 5)', () => {
    vi.useFakeTimers();
    const idle = [{ key: 'a', loading: false }, { key: 'b', loading: false }];
    const { rerender } = render(<PageLoadProgress steps={idle} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    rerender(<PageLoadProgress steps={[{ key: 'a', loading: true }, { key: 'b', loading: false }]} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Loading 0 of 1 · 0%');
  });
});
