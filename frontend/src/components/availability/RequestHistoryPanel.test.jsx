/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const historySpy = vi.fn();
vi.mock('../../services/api', () => ({
  availabilityAPI: { requestHistory: (...args) => historySpy(...args) },
}));

const { default: RequestHistoryPanel } = await import('./RequestHistoryPanel');

const config = {
  leaveTypes: [
    { id: 1, name: 'Vacation', color: 'emerald', unit: 'day' },
    { id: 8, name: 'Banked time', color: 'teal', unit: 'day' },
  ],
  people: [
    { email: 'mo@example.com', name: 'Mo Example', inWorkspace: true },
    { email: 'away@example.com', name: 'Other Team', inWorkspace: false },
  ],
};

const banked = {
  id: 161,
  email: 'mo@example.com',
  name: 'Mo Example',
  leaveTypeId: 8,
  startDate: '2026-10-21',
  endDate: '2026-10-21',
  dayPart: 'full',
  days: 1,
  hours: 8,
  status: 'approved',
  source: 'app',
  createdAt: '2026-10-20T19:21:09.434Z',
  vacationTracker: { state: 'skipped', label: 'Not in Vacation Tracker: it has no "Banked time" leave type' },
  events: [
    { kind: 'created', actor: 'mo@example.com', createdAt: '2026-10-20T19:21:09.434Z' },
    { kind: 'auto_approved', actor: 'rules', createdAt: '2026-10-20T19:21:09.434Z' },
    { kind: 'vt_write_skipped', actor: 'vacation_tracker', details: { reason: 'No Vacation Tracker leave type matches "Banked time"' }, createdAt: '2026-10-20T19:21:10.343Z' },
  ],
};

beforeEach(() => {
  historySpy.mockReset();
  historySpy.mockResolvedValue({ data: { requests: [banked], truncated: false } });
});
afterEach(cleanup);

describe('RequestHistoryPanel (QA 10-21 #1)', () => {
  test('lists the team\'s requests with how each reached Vacation Tracker', async () => {
    render(<RequestHistoryPanel me={{ leaveTypes: [] }} config={config} />);
    const row = await screen.findByTestId('history-161');
    expect(within(row).getByText('Mo Example')).toBeInTheDocument();
    expect(within(row).getByText(/Banked time · 1 day/)).toBeInTheDocument();
    expect(within(row).getByTestId('history-vt')).toHaveTextContent('it has no "Banked time" leave type');
    expect(within(row).getByText(/Booked by Mo Example/)).toBeInTheDocument();
    expect(historySpy).toHaveBeenCalledWith({});
    // Only people in this team are offered.
    const person = screen.getByLabelText('Person', { selector: 'select' });
    expect(within(person).queryByText('Other Team')).not.toBeInTheDocument();
  });

  test('Details opens the trail: booked, approved by the rules, and the skip reason', async () => {
    render(<RequestHistoryPanel me={{ leaveTypes: [] }} config={config} />);
    const row = await screen.findByTestId('history-161');
    fireEvent.click(within(row).getByRole('button', { name: /Show the history/ }));
    const trail = within(row).getByRole('list', { name: 'Request history' });
    expect(within(trail).getByText('Approved by the rules')).toBeInTheDocument();
    expect(within(trail).getByText('Not added to Vacation Tracker')).toBeInTheDocument();
    expect(within(trail).getByText(/No Vacation Tracker leave type matches "Banked time"/)).toBeInTheDocument();
  });

  test('filters go to the server: person, status, type and dates', async () => {
    render(<RequestHistoryPanel me={{ leaveTypes: [] }} config={config} />);
    await screen.findByTestId('history-161');
    fireEvent.change(screen.getByLabelText('Person', { selector: 'select' }), { target: { value: 'mo@example.com' } });
    fireEvent.change(screen.getByLabelText('Status', { selector: 'select' }), { target: { value: 'approved' } });
    fireEvent.change(screen.getByLabelText('Type', { selector: 'select' }), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('From', { selector: 'input' }), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(historySpy).toHaveBeenLastCalledWith({ email: 'mo@example.com', status: 'approved', leaveTypeId: '8', from: '2026-10-01' }));
  });

  test('an empty result says so', async () => {
    historySpy.mockResolvedValue({ data: { requests: [], truncated: false } });
    render(<RequestHistoryPanel me={{ leaveTypes: [] }} config={config} />);
    expect(await screen.findByText('No requests match.')).toBeInTheDocument();
  });
});
