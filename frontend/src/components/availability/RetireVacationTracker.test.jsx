/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Retire Vacation Tracker (26 Nov 2026):
 *   - Vacation Pulse → Settings → Vacation Tracker, before (status, the
 *     button, the plain confirm) and after (when, by whom, the report);
 *   - the General and Import sections drop their Vacation Tracker parts;
 *   - a booking made there reads "Booked in Vacation Tracker" and behaves
 *     like any other once retired.
 * Invented people only.
 */

const api = vi.hoisted(() => ({
  vtRetirementStatus: vi.fn(),
  retireVacationTracker: vi.fn(),
  vtImportStatus: vi.fn(),
  importVacationTracker: vi.fn(),
  reproject: vi.fn(),
  calendarImportStatus: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));

const { default: VacationTrackerSection, RETIRE_CONFIRM, fmtDates } = await import('./admin/VacationTrackerSection');
const { default: GeneralSection } = await import('./admin/GeneralSection');
const { default: ImportSection } = await import('./admin/ImportSection');
const { default: MyRequestsList } = await import('./MyRequestsList');
const { ComingUpRow } = await import('./ComingUpCard');

const BEFORE = { retired: null, upcomingFromVt: 7, syncing: true, lastSyncAt: '2099-11-26T17:00:00.000Z', writeBackEnabled: true, canRetire: true };
const REPORT = {
  handedOver: 7,
  directRowsReplaced: 40,
  keptUnmatched: [{ technicianId: 13, technicianName: 'Jo Park', workspaceId: 1, leaveType: 'PTO', category: 'OFF', dates: ['2099-12-07', '2099-12-08', '2099-12-09'] }],
  failed: [],
};
const AFTER = { ...BEFORE, syncing: false, retired: { retiredAt: '2099-11-26T18:00:00.000Z', retiredBy: 'sam.super@example.com', retiredByName: 'Sam Super', report: REPORT } };

beforeEach(() => {
  vi.clearAllMocks();
  api.vtImportStatus.mockResolvedValue({ data: null });
  api.calendarImportStatus.mockResolvedValue({ data: { modes: [], workspaces: [] } });
});
afterEach(() => cleanup());

describe('Settings → Vacation Tracker, before retiring', () => {
  test('says it still syncs and how many upcoming bookings came from there', async () => {
    api.vtRetirementStatus.mockResolvedValue({ data: BEFORE });
    render(<VacationTrackerSection toast={vi.fn()} />);
    const status = await screen.findByTestId('vt-status');
    expect(status).toHaveTextContent('Syncing every hour');
    expect(status).toHaveTextContent('7 upcoming bookings came from Vacation Tracker');
  });

  test('Retire asks first, in plain words; "Not now" changes nothing; yes retires and shows the report', async () => {
    api.vtRetirementStatus.mockResolvedValueOnce({ data: BEFORE }).mockResolvedValue({ data: AFTER });
    api.retireVacationTracker.mockResolvedValue({ data: { ...REPORT, retiredAt: AFTER.retired.retiredAt } });
    const toast = vi.fn();
    const reload = vi.fn();
    render(<VacationTrackerSection toast={toast} reload={reload} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retire Vacation Tracker' }));
    const confirm = screen.getByRole('group', { name: 'Confirm retiring Vacation Tracker' });
    expect(confirm).toHaveTextContent(RETIRE_CONFIRM);
    expect(RETIRE_CONFIRM).toBe('Ticket Pulse stops reading from and writing to Vacation Tracker. Upcoming bookings made there move to Vacation Pulse and can be changed here. Past leave stays as it is.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Not now' }));
    expect(api.retireVacationTracker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retire Vacation Tracker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, retire Vacation Tracker' }));
    await waitFor(() => expect(api.retireVacationTracker).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith('Vacation Tracker retired · 7 bookings moved to Vacation Pulse');
    expect(reload).toHaveBeenCalled();
    expect(await screen.findByTestId('vt-retired')).toHaveTextContent('Retired on Nov 26, 2099 by Sam Super');
  });

  test('only a super admin can press it', async () => {
    api.vtRetirementStatus.mockResolvedValue({ data: { ...BEFORE, canRetire: false } });
    render(<VacationTrackerSection toast={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Retire Vacation Tracker' })).toBeDisabled();
    expect(screen.getByText('Only a super admin can retire Vacation Tracker.')).toBeInTheDocument();
  });
});

describe('Settings → Vacation Tracker, after retiring', () => {
  test('when and by whom, what moved, and the leave-days kept for a look; no Retire button', async () => {
    api.vtRetirementStatus.mockResolvedValue({ data: AFTER });
    render(<VacationTrackerSection toast={vi.fn()} />);
    const box = await screen.findByTestId('vt-retired');
    expect(box).toHaveTextContent('Retired on Nov 26, 2099 by Sam Super');
    const report = within(box).getByTestId('vt-retire-report');
    expect(report).toHaveTextContent('7 bookings moved to Vacation Pulse · 40 leave-days replaced by them');
    const kept = within(report).getByRole('list', { name: 'Leave-days kept for a look' });
    expect(kept).toHaveTextContent('Jo Park');
    expect(kept).toHaveTextContent('PTO');
    expect(kept).toHaveTextContent(fmtDates(['2099-12-07', '2099-12-08', '2099-12-09']));
    expect(screen.queryByRole('button', { name: 'Retire Vacation Tracker' })).toBeNull();
    expect(screen.queryByTestId('vt-status')).toBeNull();
  });

  test('consecutive days read as one range', () => {
    expect(fmtDates(['2099-12-09', '2099-12-07', '2099-12-08'])).toMatch(/^\D+ \d+ – \D+ \d+$/);
    expect(fmtDates(['2099-12-07', '2099-12-10']).split(' · ')).toHaveLength(2);
  });

  test('General drops the write-back switch, Import drops the import', () => {
    const settings = { yearStartMonth: 1, vtWriteBackEnabled: true, vtRetired: true };
    const { unmount } = render(<GeneralSection config={{ settings }} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.queryByText('Copy approved requests to Vacation Tracker')).toBeNull();
    unmount();
    render(<GeneralSection config={{ settings: { ...settings, vtRetired: false } }} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByText('Copy approved requests to Vacation Tracker')).toBeInTheDocument();
    cleanup();
    render(<ImportSection toast={vi.fn()} config={{ settings }} />);
    expect(screen.getByTestId('vt-import-retired')).toHaveTextContent('Vacation Tracker is retired');
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(api.vtImportStatus).not.toHaveBeenCalled();
  });
});

describe('a booking made in Vacation Tracker, once retired', () => {
  const types = [{ id: 1, name: 'Vacation', color: 'emerald', unit: 'day', availability: 'OFF' }];
  const typeById = new Map(types.map((t) => [t.id, t]));
  const row = (over) => ({ id: 1, leaveTypeId: 1, startDate: '2099-12-02', endDate: '2099-12-02', dayPart: 'full', days: 1, hours: 8, status: 'approved', source: 'vacation_tracker', ...over });

  test('the list says "Booked in Vacation Tracker", not "change it there"; waiting ones can be changed', () => {
    const onEdit = vi.fn();
    render(<MyRequestsList requests={[row({ vtRetired: true }), row({ id: 2, status: 'pending', vtRetired: true, startDate: '2099-12-09', endDate: '2099-12-09' })]} typeById={typeById} onCancel={vi.fn()} onEdit={onEdit} />);
    const first = screen.getByTestId('my-request-1');
    expect(first).toHaveTextContent('Booked in Vacation Tracker');
    expect(within(first).getByText('· Booked in Vacation Tracker')).not.toHaveAttribute('title', expect.stringContaining('change it there'));
    expect(within(screen.getByTestId('my-request-2')).getByRole('button', { name: /^Change/ })).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('group', { name: 'Confirm cancel' });
    expect(confirm).toHaveTextContent('Booked in Vacation Tracker, which is retired: it is cancelled here only.');
    expect(confirm).not.toHaveTextContent('cancels it there too');
  });

  test('before retiring the old words stay', () => {
    render(<MyRequestsList requests={[row({})]} typeById={typeById} onCancel={vi.fn()} />);
    expect(within(screen.getByTestId('my-request-1')).getByTitle('Booked in Vacation Tracker; change it there or cancel it here')).toBeInTheDocument();
  });

  test('Coming up: "booked in Vacation Tracker", can be changed while waiting', () => {
    render(<ul><ComingUpRow r={row({ status: 'pending', vtRetired: true })} type={types[0]} today="2099-11-26" onCancel={vi.fn()} onEdit={vi.fn()} /></ul>);
    expect(screen.getByTestId('coming-up-1-what')).toHaveTextContent('Vacation · booked in Vacation Tracker');
    expect(screen.getByRole('button', { name: /^Change Vacation/ })).toBeInTheDocument();
  });
});
