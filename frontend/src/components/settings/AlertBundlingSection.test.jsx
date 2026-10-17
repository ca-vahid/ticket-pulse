/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Settings → Alert correlation → Bursts from connected monitors (17 Oct 2026):
// one switch that saves at once, and "When N alerts of the same check arrive
// within T" once it is on.
const api = vi.hoisted(() => ({ getBundling: vi.fn(), updateBundling: vi.fn() }));
vi.mock('../../services/api', () => ({ alertCorrelationAPI: api }));

const { default: AlertBundlingSection } = await import('./AlertBundlingSection');

const page = (over = {}) => ({ enabled: false, minCount: 3, windowMinutes: 60, minCountChoices: [2, 3, 4, 5], windowChoices: [30, 60, 120, 240], openBundles: 0, ...over });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getBundling.mockResolvedValue({ data: { data: page() } });
  api.updateBundling.mockImplementation((patch) => Promise.resolve({ data: { data: page(patch) } }));
});

const sw = () => screen.getByRole('switch', { name: /Bundle bursts into one incident/ });

describe('AlertBundlingSection', () => {
  test('off: the switch only; turning it on saves at once and shows the burst size', async () => {
    render(<AlertBundlingSection />);
    await waitFor(() => expect(sw()).not.toBeDisabled());
    expect(screen.queryByLabelText('How many alerts')).toBeNull();
    fireEvent.click(sw());
    await waitFor(() => expect(api.updateBundling).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(sw()).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('alerts of the same check arrive within')).toBeInTheDocument();
    expect(screen.getByTestId('open-bundles')).toHaveTextContent('No open incidents.');
  });

  test('on: shows how many incidents are open', async () => {
    api.getBundling.mockResolvedValue({ data: { data: page({ enabled: true, openBundles: 2 }) } });
    render(<AlertBundlingSection />);
    expect(await screen.findByTestId('open-bundles')).toHaveTextContent('2 open incidents.');
  });
});
