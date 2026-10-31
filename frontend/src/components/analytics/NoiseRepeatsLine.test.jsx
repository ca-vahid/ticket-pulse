/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NoiseRepeatsLine from './NoiseRepeatsLine';

describe('NoiseRepeatsLine', () => {
  afterEach(cleanup);

  it('shows noise and repeats as separate counts of the created total', () => {
    render(<NoiseRepeatsLine breakdowns={{ noiseShare: { count: 205, pct: 13.2 }, repeatShare: { count: 99, pct: 6.4 }, createdInRange: 1552 }} />);
    const line = screen.getByTestId('noise-repeats-line');
    expect(line.textContent).toBe('Noise 205 (13.2%) · Repeats 99 (6.4%) · of 1,552 created in range');
  });

  it('keeps Repeats 0 on the line when there are none', () => {
    render(<NoiseRepeatsLine breakdowns={{ noiseShare: { count: 3, pct: 1 }, createdInRange: 300 }} />);
    expect(screen.getByTestId('noise-repeats-line').textContent).toContain('Repeats 0 (0%)');
  });

  it('says both are left out when Exclude noise is on', () => {
    render(<NoiseRepeatsLine breakdowns={{ noiseShare: { count: 0, pct: 0 } }} excludeNoise />);
    expect(screen.getByText(/left out \(Exclude noise is on\)/)).toBeTruthy();
  });
});
