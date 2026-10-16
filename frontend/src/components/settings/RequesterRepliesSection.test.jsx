/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Settings → Ticket Ops → When a requester replies (13 Oct 2026; one page
// since 14 Oct 2026): which statuses reopen (a tick list), the thank-you
// switch with its monthly limit, and the owner-away / new-request switches.
// Plain labelled switches and tick boxes — no codes, no JSON.
const api = vi.hoisted(() => ({
  getRequesterReplySettings: vi.fn(),
  updateRequesterReplySettings: vi.fn(),
  restoreRequesterReplyWorkflow: vi.fn(),
}));
vi.mock('../../services/api', () => ({ ticketsAPI: api }));

const { default: RequesterRepliesSection } = await import('./RequesterRepliesSection');

const STATUSES = [
  { name: 'Pending', baseStatus: 'Pending' }, { name: 'Pending Response', baseStatus: 'Pending' },
  { name: 'Resolved', baseStatus: 'Resolved' }, { name: 'Closed', baseStatus: 'Closed' },
];
const SEEDED = { id: 9764, name: 'Reopen on requester reply', isEnabled: true, shape: 'reopen_only' };
const page = (over = {}) => ({
  rerouteWhenOwnerAway: true,
  suggestNewRequest: false,
  reopenOnReply: false,
  reopenStatuses: [],
  ignoreThanks: false,
  replyCheckMonthlyCapUsd: 10,
  retiredWorkflows: [],
  statuses: STATUSES,
  suggestedReopenStatuses: ['Resolved', 'Closed', 'Pending Response'],
  reopenWorkflows: [SEEDED],
  replyCheckCapChoices: [5, 10, 25, 50],
  replyCheckBudget: { capUsd: 10, spentUsd: 0.4231, checks: 37 },
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getRequesterReplySettings.mockResolvedValue({ data: { data: page() } });
  api.updateRequesterReplySettings.mockImplementation((patch) => Promise.resolve({ data: { data: page(patch) } }));
});

const sw = (name) => screen.getByRole('switch', { name: new RegExp(name) });
const away = () => sw('Send the ticket back for assignment when its owner is away');
const newRequest = () => sw('Suggest a new ticket when a reply is really a new request');
const reopen = () => sw('Reopen the ticket');
const thanks = () => sw('A thank-you or out-of-office reply does not reopen');
const box = (name) => screen.getByRole('checkbox', { name });

describe('RequesterRepliesSection', () => {
  test('renders the reopen switch, the thank-you switch and both follow-up switches, in plain words', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    expect(screen.getByRole('region', { name: 'When a requester replies' })).toBeInTheDocument();
    expect(reopen()).toHaveAttribute('aria-checked', 'false');
    expect(thanks()).toHaveAttribute('aria-checked', 'false');
    expect(away()).toHaveAttribute('aria-checked', 'true');
    expect(newRequest()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/away for more than one working day/)).toBeInTheDocument();
    expect(screen.getByText(/A single day off, working from home and half days do not count/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is split until a person says so/)).toBeInTheDocument();
    expect(screen.getByText(/You do not need to turn this on: the mail workflow “Reopen on requester reply” already reopens tickets/)).toBeInTheDocument();
  });

  test('no JSON, no codes anywhere on the page', async () => {
    api.getRequesterReplySettings.mockResolvedValue({ data: { data: page({ reopenOnReply: true, reopenStatuses: ['Resolved'], ignoreThanks: true, reopenWorkflows: [], retiredWorkflows: [{ id: 9764, name: 'Reopen on requester reply', wasEnabled: true, at: '2026-10-14T18:00:00Z' }] }) } });
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(away()).toBeEnabled());
    const text = screen.getByRole('region', { name: 'When a requester replies' }).textContent;
    expect(text).not.toMatch(/[{}[\]]/);
    expect(text).not.toMatch(/reopenStatuses|ignoreThanks|replyVerdict|requester_reply|reopen_only|true|false|null/);
    expect(screen.queryByRole('textbox')).toBeNull(); // nothing to type
  });

  test('turning the reopen on shows the tick list with the suggested statuses ticked; Save sends exactly those, then names what it replaced', async () => {
    api.updateRequesterReplySettings.mockResolvedValueOnce({
      data: {
        data: page({ reopenOnReply: true, reopenStatuses: ['Resolved', 'Closed', 'Pending Response'], reopenWorkflows: [], retiredWorkflows: [{ id: 9764, name: 'Reopen on requester reply', wasEnabled: true, at: '2026-10-14T18:00:00Z' }] }),
        retirement: { retired: [{ id: 9764, name: 'Reopen on requester reply' }], kept: [], failed: [] },
      },
    });
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(reopen()).toBeEnabled());
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(reopen());
    expect(reopen()).toHaveAttribute('aria-checked', 'true');
    expect(box('Resolved')).toBeChecked();
    expect(box('Closed')).toBeChecked();
    expect(box('Pending Response')).toBeChecked();
    expect(box('Pending')).not.toBeChecked();
    expect(screen.getByText(/Saving archives the mail workflow “Reopen on requester reply” \(it is not deleted\)/)).toBeInTheDocument();
    expect(api.updateRequesterReplySettings).not.toHaveBeenCalled(); // nothing saved (or archived) yet

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenCalledWith({ reopenOnReply: true, reopenStatuses: ['Resolved', 'Closed', 'Pending Response'] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. “Reopen on requester reply” is archived in Mail Workflows (not deleted); this page reopens tickets now.');
    expect(screen.getByTestId('reopen-replaced')).toHaveTextContent('Replaces the mail workflow “Reopen on requester reply”, archived 14 Oct (not deleted).');
  });

  test('ticks change the draft only; Save is off with nothing ticked; Cancel puts it back', async () => {
    api.getRequesterReplySettings.mockResolvedValue({ data: { data: page({ reopenOnReply: true, reopenStatuses: ['Resolved'], reopenWorkflows: [] }) } });
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(reopen()).toBeEnabled());
    expect(box('Resolved')).toBeChecked();
    fireEvent.click(box('Resolved'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText('Tick at least one status.')).toBeInTheDocument();
    fireEvent.click(box('Closed'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(box('Resolved')).toBeChecked();
    expect(box('Closed')).not.toBeChecked();
    expect(api.updateRequesterReplySettings).not.toHaveBeenCalled();
  });

  test('turning the reopen off warns first, and afterwards the page says nothing reopens — with a way to bring the workflow back', async () => {
    const retiredWf = { id: 9764, name: 'Reopen on requester reply', wasEnabled: true, at: '2026-10-14T18:00:00Z' };
    api.getRequesterReplySettings.mockResolvedValue({ data: { data: page({ reopenOnReply: true, reopenStatuses: ['Resolved'], reopenWorkflows: [], retiredWorkflows: [retiredWf] }) } });
    api.updateRequesterReplySettings.mockResolvedValueOnce({ data: { data: page({ reopenOnReply: false, reopenStatuses: ['Resolved'], reopenWorkflows: [], retiredWorkflows: [retiredWf] }) } });
    api.restoreRequesterReplyWorkflow.mockResolvedValueOnce({ data: { data: page({ reopenWorkflows: [SEEDED] }) } });
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(reopen()).toBeEnabled());
    fireEvent.click(reopen());
    expect(screen.getByText(/After saving, nothing reopens tickets when a requester replies/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenCalledWith({ reopenOnReply: false }));
    const nothing = await screen.findByTestId('nothing-reopens');
    expect(nothing).toHaveTextContent('Nothing reopens tickets when a requester replies in this workspace.');
    expect(api.restoreRequesterReplyWorkflow).not.toHaveBeenCalled(); // never brought back by itself

    fireEvent.click(within(nothing).getByRole('button', { name: 'Bring back “Reopen on requester reply”' }));
    await waitFor(() => expect(api.restoreRequesterReplyWorkflow).toHaveBeenCalledWith(9764));
    expect(await screen.findByText(/You do not need to turn this on: the mail workflow “Reopen on requester reply” already reopens tickets/)).toBeInTheDocument();
  });

  test('the thank-you switch saves at once and shows the monthly limit and this month\'s spend', async () => {
    render(<RequesterRepliesSection />);
    await waitFor(() => expect(thanks()).toBeEnabled());
    fireEvent.click(thanks());
    await waitFor(() => expect(api.updateRequesterReplySettings).toHaveBeenCalledWith({ ignoreThanks: true }));
    await waitFor(() => expect(thanks()).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('combobox', { name: 'Monthly limit for reading replies' })).toHaveTextContent('$10');
    expect(screen.getByTestId('reply-check-spend')).toHaveTextContent('This month: $0.42, 37 replies read. At the limit, replies reopen.');
    expect(screen.getByText(/this works when its step has “Ignore a thank-you or out-of-office reply” switched on/)).toBeInTheDocument();
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
