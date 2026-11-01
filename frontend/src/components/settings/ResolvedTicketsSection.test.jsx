/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Settings → Ticket Ops → When a ticket is resolved (17 Oct 2026): one switch
// and a "close after" time, saved with its own Save because turning it on
// closes the tickets already past that time — the page says how many.
const api = vi.hoisted(() => ({
  getAutoCloseSettings: vi.fn(),
  updateAutoCloseSettings: vi.fn(),
}));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: ResolvedTicketsSection } = await import('./ResolvedTicketsSection');

const CHOICES = [[1, '1 hour'], [4, '4 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '1 week']].map(([hours, label]) => ({ hours, label }));
const page = (over = {}) => ({
  enabled: false,
  afterHours: 48,
  choices: CHOICES,
  resolvedNow: 61,
  resolvedAllNow: 74,
  dueByChoice: { 1: 60, 4: 59, 24: 57, 48: 55, 72: 54, 168: 40 },
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getAutoCloseSettings.mockResolvedValue({ data: { data: page() } });
  api.updateAutoCloseSettings.mockImplementation((patch) => Promise.resolve({ data: { data: page(patch) } }));
});

const sw = () => screen.getByRole('switch', { name: /Close resolved tickets automatically/ });

describe('ResolvedTicketsSection', () => {
  test('off: one switch, no time picker, nothing to save', async () => {
    render(<ResolvedTicketsSection />);
    await waitFor(() => expect(sw()).not.toBeDisabled());
    expect(sw()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Close after')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  test('turning it on shows the time, says how many close at once, and saves on Save only', async () => {
    render(<ResolvedTicketsSection />);
    await waitFor(() => expect(sw()).not.toBeDisabled());
    fireEvent.click(sw());
    expect(api.updateAutoCloseSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('auto-close-due')).toHaveTextContent('55 tickets have been resolved for longer than 2 days and will close within a few minutes of saving.');
    expect(screen.getByTestId('auto-close-now')).toHaveTextContent('61 tickets resolved now.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAutoCloseSettings).toHaveBeenCalledWith({ enabled: true, afterHours: 48, retireResolved: false }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Resolved tickets close after 2 days; the 55 tickets already past that close within the next few minutes.');
    expect(sw()).toHaveAttribute('aria-checked', 'true');
  });

  test('Cancel drops the change; turning it off saves enabled false', async () => {
    api.getAutoCloseSettings.mockResolvedValue({ data: { data: page({ enabled: true }) } });
    render(<ResolvedTicketsSection />);
    await waitFor(() => expect(sw()).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAutoCloseSettings).toHaveBeenCalledWith({ enabled: false, retireResolved: false }));
    expect(await screen.findByRole('status')).toHaveTextContent('no longer closes resolved tickets');
  });

  test('QA 10-30 #2: Retire Resolved says how many close (FreshService ones too) and saves on Save', async () => {
    render(<ResolvedTicketsSection />);
    const retire = () => screen.getByRole('switch', { name: /Retire Resolved/ });
    await waitFor(() => expect(retire()).not.toBeDisabled());
    expect(retire()).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(retire());
    expect(screen.getByTestId('retire-resolved-due')).toHaveTextContent('74 tickets are Resolved now and will close within a few minutes of saving.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAutoCloseSettings).toHaveBeenCalledWith({ enabled: false, retireResolved: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Resolved is retired');
  });
});
