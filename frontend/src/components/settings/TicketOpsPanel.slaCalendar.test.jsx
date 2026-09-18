/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SlaSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// Phase SLA (QA 08-17 #9) + QA 09-17 #1 — Settings → Ticket Ops → SLA card:
// the per-workspace "Calendar-aware SLAs" toggle, its business-hours vs
// business-days style, and the per-priority clock selector (policy
// calendarMode inherit / calendar / business_days / always_on).

const TYPES = [{ id: 7, name: 'Incident', color: 'red', abbreviation: 'INC', isActive: true }];
const POLICIES = [
  { id: 1, priority: 4, ticketTypeId: 7, firstResponseMinutes: 30, resolveMinutes: 240, calendarMode: 'inherit', isActive: true },
  { id: 2, priority: 3, ticketTypeId: 7, firstResponseMinutes: 60, resolveMinutes: 480, calendarMode: 'always_on', isActive: true },
];

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getSlaPolicies: vi.fn(() => Promise.resolve({ data: { data: POLICIES } })),
    upsertSlaPolicy: vi.fn(() => Promise.resolve({})),
    deleteSlaPolicy: vi.fn(() => Promise.resolve({})),
    getSlaCalendar: vi.fn(() => Promise.resolve({ data: { data: { slaCalendarAware: false, slaCalendarStyle: 'business_hours' } } })),
    updateSlaCalendar: vi.fn((slaCalendarAware, slaCalendarStyle) => Promise.resolve({
      data: { data: { slaCalendarAware, slaCalendarStyle: slaCalendarStyle || 'business_hours' } },
    })),
  },
  ticketsAPI: {},
  workspaceAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: TYPES, activeTypes: TYPES, defaultType: TYPES[0], refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1 } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded({ calendarAware = false, calendarStyle = 'business_hours', policies = POLICIES } = {}) {
  settingsAPI.getSlaPolicies.mockResolvedValueOnce({ data: { data: policies } });
  settingsAPI.getSlaCalendar.mockResolvedValueOnce({ data: { data: { slaCalendarAware: calendarAware, slaCalendarStyle: calendarStyle } } });
  render(<SlaSection />);
  await waitFor(() => expect(screen.getByRole('switch', { name: /Calendar-aware SLAs/ })).toBeEnabled());
}

describe('SlaSection — calendar-aware toggle', () => {
  test('renders the toggle with the pointer to Business Hours & Holidays and the Pending answer', async () => {
    await renderLoaded();
    expect(screen.getByText('Calendar-aware SLAs')).toBeInTheDocument();
    expect(screen.getByText(/Business Hours & Holidays/)).toBeInTheDocument();
    // QA's actual question answered in-panel: Pending ALREADY pauses.
    expect(screen.getByText(/already pauses while a ticket is Pending/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Calendar-aware SLAs off/ })).toHaveAttribute('aria-checked', 'false');
  });

  test('flipping the switch PUTs the workspace flag and reflects the response', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /Calendar-aware SLAs/ }));
    await waitFor(() => expect(settingsAPI.updateSlaCalendar).toHaveBeenCalledWith(true, 'business_hours'));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Calendar-aware SLAs on/ })).toHaveAttribute('aria-checked', 'true'));
  });

  test('the style choice is hidden while the workspace flag is off', async () => {
    await renderLoaded({ calendarAware: false });
    expect(screen.queryByRole('radiogroup', { name: /Calendar style/ })).not.toBeInTheDocument();
  });
});

// QA 09-17 #1 — "It's still counting the weekends": the workspace toggle was
// on, but it meant business HOURS. Business days is the 24-hour clock that
// skips non-working days (Fri 2pm + 24h = Mon 2pm).
describe('SlaSection — calendar style', () => {
  test('shows both styles with the Friday example, current one checked', async () => {
    await renderLoaded({ calendarAware: true, calendarStyle: 'business_hours' });
    const hours = screen.getByRole('radio', { name: /Business hours/ });
    const days = screen.getByRole('radio', { name: /Business days/ });
    expect(hours).toHaveAttribute('aria-checked', 'true');
    expect(days).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Fri 2pm + 24h → Mon 2pm')).toBeInTheDocument();
  });

  test('picking business days PUTs the style and keeps the flag on', async () => {
    await renderLoaded({ calendarAware: true, calendarStyle: 'business_hours' });
    fireEvent.click(screen.getByRole('radio', { name: /Business days/ }));
    await waitFor(() => expect(settingsAPI.updateSlaCalendar).toHaveBeenCalledWith(true, 'business_days'));
    await waitFor(() => expect(screen.getByRole('radio', { name: /Business days/ })).toHaveAttribute('aria-checked', 'true'));
  });

  test('warns when the calendar is on but every row overrides it with 24/7', async () => {
    const allAlwaysOn = POLICIES.map((p) => ({ ...p, calendarMode: 'always_on' }));
    await renderLoaded({ calendarAware: true, policies: allAlwaysOn });
    expect(await screen.findByText(/every clock below is set to/)).toBeInTheDocument();
  });

  test('no warning when at least one row follows the workspace default', async () => {
    await renderLoaded({ calendarAware: true });
    await screen.findByRole('radio', { name: /Business days/ });
    expect(screen.queryByText(/every clock below is set to/)).not.toBeInTheDocument();
  });
});

describe('SlaSection — per-priority clock', () => {
  test('each policy row shows its clock, with the resolved workspace default named', async () => {
    await renderLoaded({ calendarAware: true, calendarStyle: 'business_days' });
    const urgent = await screen.findByRole('combobox', { name: 'Urgent SLA clock' });
    const high = screen.getByRole('combobox', { name: 'High SLA clock' });
    expect(urgent).toHaveValue('inherit');
    expect(high).toHaveValue('always_on');
    // The "Workspace default" option names what it currently resolves to.
    expect(screen.getAllByRole('option', { name: 'Workspace default (Business days)' }).length).toBeGreaterThan(0);
    // Rows without a policy (Medium/Low) get no selector.
    expect(screen.queryByRole('combobox', { name: 'Medium SLA clock' })).not.toBeInTheDocument();
  });

  test('the clock is offered even while the workspace toggle is off — a row can override it', async () => {
    await renderLoaded({ calendarAware: false });
    expect(await screen.findByRole('combobox', { name: 'Urgent SLA clock' })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'Workspace default (24/7)' }).length).toBeGreaterThan(0);
  });

  test('changing the clock re-upserts the policy with the new mode and existing minutes', async () => {
    await renderLoaded({ calendarAware: true });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Urgent SLA clock' }), { target: { value: 'business_days' } });
    await waitFor(() => expect(settingsAPI.upsertSlaPolicy).toHaveBeenCalledWith({
      priority: 4, ticketTypeId: 7, firstResponseMinutes: 30, resolveMinutes: 240, calendarMode: 'business_days',
    }));

    fireEvent.change(screen.getByRole('combobox', { name: 'High SLA clock' }), { target: { value: 'inherit' } });
    await waitFor(() => expect(settingsAPI.upsertSlaPolicy).toHaveBeenCalledWith({
      priority: 3, ticketTypeId: 7, firstResponseMinutes: 60, resolveMinutes: 480, calendarMode: 'inherit',
    }));
  });
});
