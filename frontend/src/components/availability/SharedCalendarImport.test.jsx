/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * QA 11-16: Accounting's shared calendar → Vacation Pulse.
 *   Settings → Import shows Off / Shadow / Live per calendar workspace, the
 *   last run's counts, and the names not matched (linking to Settings →
 *   Shared Calendar). Imported requests say where they came from and can be
 *   cancelled, never changed. Invented names only.
 */

const api = vi.hoisted(() => ({
  vtImportStatus: vi.fn(),
  importVacationTracker: vi.fn(),
  reproject: vi.fn(),
  calendarImportStatus: vi.fn(),
  setCalendarImportMode: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api, getWorkspaceId: () => 2 }));

const { SharedCalendarImport } = await import('./admin/ImportSection');
const { default: MyRequestsList } = await import('./MyRequestsList');

const STATUS = {
  modes: ['off', 'shadow', 'live'],
  workspaces: [{
    workspaceId: 2,
    name: 'Accounting Team',
    syncEnabled: true,
    mode: 'shadow',
    lastRun: {
      at: '2099-11-16T23:15:00.000Z',
      mode: 'shadow',
      ok: true,
      counts: { created: 42, updated: 0, cancelled: 1, unchanged: 0, skipped_tentative: 3, skipped_private: 1, skipped_unmatched: 5, skipped_app_booked: 2 },
      unmatched: [{ name: 'Zed', events: 4 }, { name: 'Quinn', events: 1 }],
      tentative: [{ name: 'Ana', date: '2099-12-01', subject: 'Ana vacation placeholder (tentative)' }],
    },
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.calendarImportStatus.mockResolvedValue({ data: STATUS });
  api.setCalendarImportMode.mockResolvedValue({ data: { workspaceId: 2, mode: 'live' } });
});
afterEach(() => cleanup());

describe('Settings → Import: Shared calendar', () => {
  test('shows the mode, what the Shadow run would do, the skips and the unmatched names', async () => {
    render(<MemoryRouter><SharedCalendarImport toast={vi.fn()} /></MemoryRouter>);
    const block = await screen.findByTestId('cal-import-2');
    const modes = within(block).getByRole('group', { name: 'Shared calendar import for Accounting Team' });
    expect(within(modes).getByRole('button', { name: 'Shadow' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(block).getByTestId('cal-import-run')).toHaveTextContent('it would create 42, update 0 and cancel 1. Nothing was written.');
    expect(within(block).getByTestId('cal-import-skipped')).toHaveTextContent('5 not matched to a person, 3 tentative or placeholder, 1 private, 2 already booked in Vacation Pulse');
    const unmatched = within(block).getByTestId('cal-import-unmatched');
    expect(unmatched).toHaveTextContent('Zed (4), Quinn');
    expect(within(unmatched).getByRole('link', { name: /Settings → Shared Calendar/ })).toHaveAttribute('href', '/settings#calendar-leave');
  });

  test('an admin switches it to Live', async () => {
    const toast = vi.fn();
    render(<MemoryRouter><SharedCalendarImport toast={toast} /></MemoryRouter>);
    const block = await screen.findByTestId('cal-import-2');
    fireEvent.click(within(block).getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(api.setCalendarImportMode).toHaveBeenCalledWith({ workspaceId: 2, mode: 'live' }));
    await waitFor(() => expect(within(block).getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true'));
    expect(toast).toHaveBeenCalledWith('Shared calendar import for Accounting Team: Live');
  });

  test('says so when no workspace has a calendar', async () => {
    api.calendarImportStatus.mockResolvedValue({ data: { workspaces: [] } });
    render(<MemoryRouter><SharedCalendarImport toast={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('No workspace you administer has a shared calendar set up.')).toBeInTheDocument();
  });

  test('a failed run says so; no skips line', async () => {
    api.calendarImportStatus.mockResolvedValue({ data: { workspaces: [{ ...STATUS.workspaces[0], mode: 'live', lastRun: { at: '2099-11-16T23:15:00.000Z', mode: 'live', ok: false, error: 'Graph 503' } }] } });
    render(<MemoryRouter><SharedCalendarImport toast={vi.fn()} /></MemoryRouter>);
    const block = await screen.findByTestId('cal-import-2');
    expect(within(block).getByTestId('cal-import-run')).toHaveTextContent('failed: Graph 503');
    expect(within(block).queryByTestId('cal-import-skipped')).toBeNull();
  });
});

describe('My requests: imported from the shared calendar', () => {
  const types = [{ id: 1, name: 'Vacation', color: 'emerald', unit: 'day' }];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const req = { id: 7, leaveTypeId: 1, startDate: '2099-12-01', endDate: '2099-12-03', dayPart: 'full', days: 3, hours: 24, status: 'approved', source: 'shared_calendar', decision: { reason: 'From the shared calendar' } };

  test('says where it came from after the date, can be cancelled, never changed', () => {
    render(<MyRequestsList requests={[req]} typeById={typeById} onCancel={vi.fn()} onEdit={vi.fn()} />);
    const li = screen.getByTestId('my-request-7');
    expect(li).toHaveTextContent('From the shared calendar');
    expect(within(li).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: /Change/ })).toBeNull();
    fireEvent.click(within(li).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('group', { name: 'Confirm cancel' })).toHaveTextContent('It came from the shared calendar.');
  });
});
