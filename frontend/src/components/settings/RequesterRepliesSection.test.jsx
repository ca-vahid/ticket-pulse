/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Settings → Ticket Ops → When a requester replies, trimmed in MEGA 11-14
// (A5): reopening is set in Mail Workflows, so the page keeps only the
// owner-away and new-request switches and the monthly limit for reading
// replies, with one line pointing at the reopen workflow.
const api = vi.hoisted(() => ({
  getRequesterReplySettings: vi.fn(),
  updateRequesterReplySettings: vi.fn(),
}));
const workflowApi = vi.hoisted(() => ({ reopenCheck: vi.fn() }));
vi.mock('../../services/api', () => ({ ticketsAPI: api, notificationWorkflowAPI: workflowApi }));

const { default: RequesterRepliesSection, reopenWorkflowHref } = await import('./RequesterRepliesSection');

// Contract §5: the only fields GET/PUT still carry.
const page = (over = {}) => ({
  rerouteWhenOwnerAway: true,
  suggestNewRequest: false,
  replyCheckMonthlyCapUsd: 10,
  replyCheckCapChoices: [5, 10, 25, 50],
  replyCheckBudget: { capUsd: 10, spentUsd: 0.4231, checks: 37 },
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getRequesterReplySettings.mockResolvedValue({ data: { data: page() } });
  api.updateRequesterReplySettings.mockImplementation((patch) => Promise.resolve({ data: { data: page(patch) } }));
  workflowApi.reopenCheck.mockResolvedValue({ success: true, data: { reopenWorkflows: [{ id: 9764, name: 'Reopen on requester reply', isEnabled: true }], warnings: [] } });
});

const sw = (name) => screen.getByRole('switch', { name: new RegExp(name) });
const away = () => sw('Send the ticket back for assignment when its owner is away');
const newRequest = () => sw('Suggest a new ticket when a reply is really a new request');

describe('RequesterRepliesSection (trimmed, MEGA 11-14)', () => {
  test('keeps the two follow-up switches and the monthly limit; the reopen switches are gone', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    expect(screen.getByRole('region', { name: 'When a requester replies' })).toBeInTheDocument();
    expect(away()).toHaveAttribute('aria-checked', 'true');
    expect(newRequest()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.queryByRole('switch', { name: /Reopen the ticket/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: /thank-you/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull(); // no status ticks
    expect(screen.queryByText(/archived/i)).toBeNull();
    expect(screen.queryByText(/Bring back/)).toBeNull();
    expect(screen.getByText(/away for more than one working day/)).toBeInTheDocument();
    expect(screen.getByText(/A single day off, working from home and half days do not count/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is split until a person says so/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Monthly limit for reading replies' })).toHaveTextContent('$10');
    expect(screen.getByTestId('reply-check-spend')).toHaveTextContent('This month: $0.42, 37 replies read. At the limit, replies reopen.');
  });

  test('one line points to the reopen workflow in Mail Workflows', async () => {
    render(<RequesterRepliesSection />);
    const link = await screen.findByRole('link', { name: /Mail Workflows → Reopen on requester reply/ });
    expect(screen.getByTestId('reopen-pointer')).toHaveTextContent('Reopening is set in Mail Workflows → Reopen on requester reply');
    await waitFor(() => expect(link).toHaveAttribute('href', '/workflows?wf=9764'));
  });

  test('the link falls back to the workflow list when the check fails or finds several', async () => {
    workflowApi.reopenCheck.mockRejectedValueOnce(new Error('nope'));
    render(<RequesterRepliesSection />);
    expect(await screen.findByRole('link', { name: /Mail Workflows/ })).toHaveAttribute('href', '/workflows');
    expect(reopenWorkflowHref([{ id: 1, isEnabled: true }, { id: 2, isEnabled: true }])).toBe('/workflows');
    expect(reopenWorkflowHref([{ id: 1, isEnabled: false }, { id: 2, isEnabled: true }])).toBe('/workflows?wf=2');
    expect(reopenWorkflowHref([])).toBe('/workflows');
  });

  test('no JSON, no codes anywhere on the page', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    const text = screen.getByRole('region', { name: 'When a requester replies' }).textContent;
    expect(text).not.toMatch(/[{}[\]]/);
    expect(text).not.toMatch(/reopenStatuses|ignoreThanks|replyVerdict|requester_reply|reopen_only|true|false|null/);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('the monthly limit saves at once', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    fireEvent.click(screen.getByRole('combobox', { name: 'Monthly limit for reading replies' }));
    fireEvent.click(await screen.findByRole('option', { name: '$25' }));
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenCalledWith({ replyCheckMonthlyCapUsd: 25 }));
  });

  test('flipping one follow-up switch saves only that switch', async () => {
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
