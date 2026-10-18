/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SpreadTab from './SpreadTab';

// QA 10-13 item 17: Assignment Review → Spread.
const { getSpy, saveSpy } = vi.hoisted(() => ({ getSpy: vi.fn(), saveSpy: vi.fn() }));
vi.mock('../../services/api', () => ({
  assignmentSpreadAPI: { get: (...a) => getSpy(...a), saveSettings: (...a) => saveSpy(...a) },
}));

const SETTINGS = {
  enabled: true, countRecent: true, recentWindowMinutes: 10, capEnabled: true, capCount: 3, capWindowMinutes: 10,
  keepNewHireSet: true, staggerEnabled: true, staggerCount: 2, staggerMinutes: 2,
  updatedAt: '2026-10-14T16:00:00Z', updatedBy: 'Vahid Haeri',
  history: [{ at: '2026-10-14T16:00:00Z', by: 'Vahid Haeri', changes: [{ field: 'capCount', from: 4, to: 3 }] }],
};
const DATA = {
  settings: SETTINGS,
  canManage: true,
  limits: { capCount: { min: 1, max: 20 }, capWindowMinutes: { min: 1, max: 120 }, recentWindowMinutes: { min: 1, max: 120 }, staggerCount: { min: 1, max: 10 }, staggerMinutes: { min: 2, max: 60 } },
  days: 30, windowMinutes: 10, capCount: 3,
  totals: { assignments: 120, moved: 4, keptTogether: 2, gaveWay: 1, guarded: 40 },
  before: { days: 18, assignments: 80, largestBurst: 15, daysOverCap: 4, release: { days: 12, tickets: 90, averageMinutes: 1, longestMinutes: 5 } },
  after: { days: 2, assignments: 40, largestBurst: 3, daysOverCap: 0, release: { days: 2, tickets: 20, averageMinutes: 12, longestMinutes: 18 } },
  perDay: [
    { day: '2026-10-08', assignments: 73, moved: 0, keptTogether: 0, gaveWay: 0, largestBurst: 15, rulesOn: false, released: 7, releaseMinutes: 1 },
    { day: '2026-10-12', assignments: 0, moved: 0, keptTogether: 0, gaveWay: 0, largestBurst: 0, rulesOn: false, released: 0, releaseMinutes: 0 },
    { day: '2026-10-14', assignments: 40, moved: 4, keptTogether: 2, gaveWay: 1, largestBurst: 3, rulesOn: true, released: 12, releaseMinutes: 14 },
  ],
  events: [
    { runId: 9, at: '2026-10-14T15:02:00Z', rule: 'cap', ticket: { id: 501, displayRef: 'TP-1900', subject: 'Printer offline' }, wouldHaveGoneTo: 'Dana Diaz', wentTo: 'Eli Wong', recent: 3, why: 'Given to Eli Wong instead of Dana Diaz.' },
    { runId: 8, at: '2026-10-14T15:01:00Z', rule: 'cap_gave_way', ticket: { id: 502, displayRef: '#240001', subject: 'VPN' }, wouldHaveGoneTo: 'Dana Diaz', wentTo: 'Dana Diaz', recent: 3, why: 'The cap gave way.' },
  ],
};

const mount = () => render(<MemoryRouter><SpreadTab workspaceTimezone="America/Vancouver" /></MemoryRouter>);

beforeEach(() => {
  getSpy.mockReset();
  saveSpy.mockReset();
  getSpy.mockResolvedValue({ success: true, data: DATA });
});
afterEach(cleanup);

describe('SpreadTab', () => {
  test('shows the rules with their numbers, the verdict and the results', async () => {
    mount();
    expect(await screen.findByTestId('spread-tab')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledWith(30);
    expect(screen.getByText(/the most one person got in 10 minutes is 3 \(it was 15 before\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Cap in tickets')).toHaveValue(3);
    expect(screen.getByLabelText('Cap window in minutes')).toHaveValue(10);
    expect(screen.getByLabelText('Tickets per release')).toHaveValue(2);
    expect(screen.getByLabelText('Spread automatic assignments')).toBeChecked();
    expect(screen.getByText('Moved by the cap').nextSibling).toHaveTextContent('4');
    expect(screen.getByText(/4 days of 18 over 3/)).toBeInTheDocument();
    expect(screen.getByText(/20 tickets on 2 mornings, about 12 minutes each/)).toBeInTheDocument();
    expect(screen.getByText(/Earlier changes \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Cap \(tickets\) 4 → 3/)).toBeInTheDocument();
  });

  test('day by day: quiet days are left out, a day over the cap says so, days before the rules are marked', async () => {
    mount();
    const table = (await screen.findByText('Day')).closest('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('2026-10-14');
    expect(rows[0]).toHaveTextContent('12 tickets, 14 minutes');
    expect(rows[1]).toHaveTextContent('2026-10-08 · before');
    expect(rows[1]).toHaveTextContent('15 — over 3');
  });

  test('recent changes: ticket, rule, would have gone to, went to — a plain list, no ranking of people', async () => {
    mount();
    const table = (await screen.findByText('Would have gone to')).closest('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('TP-1900');
    expect(rows[0]).toHaveTextContent('Cap');
    expect(rows[0]).toHaveTextContent('Dana Diaz');
    expect(rows[0]).toHaveTextContent('Eli Wong');
    expect(within(rows[0]).getByRole('link', { name: 'TP-1900' })).toHaveAttribute('href', '/tickets/501');
    expect(rows[1]).toHaveTextContent('Cap gave way');
    expect(rows[1]).toHaveTextContent('Dana Diaz (unchanged)');
    expect(screen.queryByText(/leaderboard|most assigned|ranking|winner/i)).not.toBeInTheDocument();
  });

  test('an admin changes the cap: only what changed is sent, and the page says it applies to the next ticket', async () => {
    saveSpy.mockResolvedValue({ success: true, data: { settings: { ...SETTINGS, capCount: 4 }, changes: [{ field: 'capCount', from: 3, to: 4 }] } });
    mount();
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Cap in tickets'), { target: { value: '4' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith({ capCount: 4 }));
    expect(await screen.findByText('Saved. It applies to the next ticket.')).toBeInTheDocument();
    expect(screen.getByLabelText('Cap in tickets')).toHaveValue(4);
  });

  test('a refused save shows the reason and keeps what was typed', async () => {
    saveSpy.mockRejectedValue({ response: { data: { message: 'capCount must be a whole number from 1 to 20' } } });
    mount();
    fireEvent.change(await screen.findByLabelText('Cap in tickets'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('capCount must be a whole number from 1 to 20');
    expect(screen.getByLabelText('Cap in tickets')).toHaveValue(99);
  });

  test('turning the main switch off greys out the four rules', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText('Spread automatic assignments'));
    expect(screen.getByLabelText('Cap')).toBeDisabled();
    expect(screen.getByLabelText('Cap in tickets')).toBeDisabled();
    expect(screen.getByLabelText('Release the overnight queue gradually')).toBeDisabled();
  });

  test('a reviewer reads everything but cannot change anything', async () => {
    getSpy.mockResolvedValue({ success: true, data: { ...DATA, canManage: false } });
    mount();
    expect(await screen.findByText('Only an admin can change these.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Spread automatic assignments')).toBeDisabled();
    expect(screen.getByLabelText('Cap in tickets')).toBeDisabled();
    expect(screen.getByText('Moved by the cap')).toBeInTheDocument();
  });

  test('off for the workspace: says so plainly', async () => {
    getSpy.mockResolvedValue({ success: true, data: { ...DATA, settings: { ...SETTINGS, enabled: false, updatedAt: null, history: [] }, after: { ...DATA.after, days: 0 }, events: [] } });
    mount();
    expect(await screen.findByText(/Off for this workspace/)).toBeInTheDocument();
    expect(screen.getByText('Never changed: these are the starting values.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing yet\. Every time a rule changes who gets a ticket/)).toBeInTheDocument();
  });

  test('the period buttons reload the results', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '7 days' }));
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith(7));
  });

  test('a failed load shows the error instead of an empty page', async () => {
    getSpy.mockRejectedValue(new Error('Network down'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
