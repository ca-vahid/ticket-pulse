/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Settings → Ticket Ops → When a requester replies (13 Oct 2026): two plain
// labelled switches, each with one sentence of explanation.
const api = vi.hoisted(() => ({ getRequesterReplySettings: vi.fn(), updateRequesterReplySettings: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: RequesterRepliesSection } = await import('./RequesterRepliesSection');

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getRequesterReplySettings.mockResolvedValue({ data: { data: { rerouteWhenOwnerAway: true, suggestNewRequest: false } } });
  api.updateRequesterReplySettings.mockImplementation((patch) => Promise.resolve({ data: { data: { rerouteWhenOwnerAway: true, suggestNewRequest: false, ...patch } } }));
});

const away = () => screen.getByRole('switch', { name: /Send the ticket back for assignment when its owner is away/ });
const newRequest = () => screen.getByRole('switch', { name: /Suggest a new ticket when a reply is really a new request/ });

describe('RequesterRepliesSection', () => {
  test('shows both switches as the workspace has them, with what each one does', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    expect(screen.getByRole('region', { name: 'When a requester replies' })).toBeInTheDocument();
    expect(away()).toHaveAttribute('aria-checked', 'true');
    expect(newRequest()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/away for more than one working day/)).toBeInTheDocument();
    expect(screen.getByText(/A single day off, working from home and half days do not count/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is split until a person says so/)).toBeInTheDocument();
  });

  test('flipping one switch saves only that switch', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(newRequest()).toBeEnabled());
    fireEvent.click(newRequest());
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenCalledWith({ suggestNewRequest: true }));
    await waitFor(() => expect(newRequest()).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(away());
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenLastCalledWith({ rerouteWhenOwnerAway: false }));
    await waitFor(() => expect(away()).toHaveAttribute('aria-checked', 'false'));
  });

  test('a refused save (not an admin) says why and keeps the switch where it was', async () => {
    api.updateRequesterReplySettings.mockRejectedValueOnce({ response: { data: { message: 'Changing what happens when a requester replies requires admin access.' } } });
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    fireEvent.click(away());
    expect(await screen.findByRole('alert')).toHaveTextContent(/requires admin access/);
    expect(away()).toHaveAttribute('aria-checked', 'true');
  });
});
