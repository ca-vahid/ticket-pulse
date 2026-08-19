/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SlaSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// Phase SLA (QA 08-17 #9) — Settings → Ticket Ops → SLA card:
// the per-workspace "Calendar-aware SLAs" toggle and the per-priority
// 24/7 escape-hatch pill (policy calendarMode inherit ⇄ always_on).

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
    getSlaCalendar: vi.fn(() => Promise.resolve({ data: { data: { slaCalendarAware: false } } })),
    updateSlaCalendar: vi.fn((v) => Promise.resolve({ data: { data: { slaCalendarAware: v } } })),
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

async function renderLoaded({ calendarAware = false } = {}) {
  settingsAPI.getSlaCalendar.mockResolvedValueOnce({ data: { data: { slaCalendarAware: calendarAware } } });
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
    await waitFor(() => expect(settingsAPI.updateSlaCalendar).toHaveBeenCalledWith(true));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Calendar-aware SLAs on/ })).toHaveAttribute('aria-checked', 'true'));
  });

  test('24/7 pills are hidden while the workspace flag is off', async () => {
    await renderLoaded({ calendarAware: false });
    expect(screen.queryByRole('button', { name: /24\/7/ })).not.toBeInTheDocument();
  });
});

describe('SlaSection — per-priority 24/7 escape hatch', () => {
  test('policy rows show the pill; always_on renders pressed', async () => {
    await renderLoaded({ calendarAware: true });
    // Urgent P4 (inherit) → unpressed; High P3 (always_on) → pressed.
    const urgent = screen.getByRole('button', { name: /Urgent SLA follows business hours/ });
    const high = screen.getByRole('button', { name: /High SLA runs 24\/7/ });
    expect(urgent).toHaveAttribute('aria-pressed', 'false');
    expect(high).toHaveAttribute('aria-pressed', 'true');
    // Rows without a policy (Medium/Low) get no pill.
    expect(screen.queryByRole('button', { name: /Medium SLA/ })).not.toBeInTheDocument();
  });

  test('clicking the pill re-upserts the policy with the flipped calendarMode and existing minutes', async () => {
    await renderLoaded({ calendarAware: true });
    fireEvent.click(screen.getByRole('button', { name: /Urgent SLA follows business hours/ }));
    await waitFor(() => expect(settingsAPI.upsertSlaPolicy).toHaveBeenCalledWith({
      priority: 4, ticketTypeId: 7, firstResponseMinutes: 30, resolveMinutes: 240, calendarMode: 'always_on',
    }));

    fireEvent.click(screen.getByRole('button', { name: /High SLA runs 24\/7/ }));
    await waitFor(() => expect(settingsAPI.upsertSlaPolicy).toHaveBeenCalledWith({
      priority: 3, ticketTypeId: 7, firstResponseMinutes: 60, resolveMinutes: 480, calendarMode: 'inherit',
    }));
  });
});
