/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * QA 11-09, Availability:
 *   #2 Cancel shows on approved, upcoming requests (Vacation Tracker ones
 *      too), with an inline confirm, and says plainly when Vacation Tracker
 *      could not be told;
 *   #1 Settings → Import says when the automatic import last ran.
 */

const api = vi.hoisted(() => ({
  myRequests: vi.fn(),
  cancelRequest: vi.fn(),
  vtImportStatus: vi.fn(),
  importVacationTracker: vi.fn(),
  reproject: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));
vi.mock('../../hooks/useAvailabilityApprovalCount', () => ({ notifyAvailabilityChanged: vi.fn() }));
vi.mock('./BookTimeForm', () => ({ default: () => <div data-testid="book-form" /> }));
vi.mock('./BalancesRow', () => ({ default: () => null }));

const { default: MyRequestsList } = await import('./MyRequestsList');
const { default: MyTimePanel } = await import('./MyTimePanel');
const { default: ImportSection, AutoImportLine } = await import('./admin/ImportSection');

const types = [{ id: 1, name: 'Vacation', color: 'emerald', unit: 'day' }];
const typeById = new Map(types.map((t) => [t.id, t]));
const row = (over) => ({ leaveTypeId: 1, startDate: '2099-12-02', endDate: '2099-12-02', dayPart: 'full', days: 1, hours: 8, status: 'approved', source: 'vacation_tracker', decision: { reason: 'Approved in Vacation Tracker' }, ...over });

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('#2 who gets a Cancel button', () => {
  test('approved upcoming: yes (from Vacation Tracker too); past or already cancelled: no', () => {
    render(<MyRequestsList
      requests={[
        row({ id: 1 }),
        row({ id: 2, startDate: '2020-01-06', endDate: '2020-01-06' }),
        row({ id: 3, status: 'cancelled' }),
        row({ id: 4, source: 'app', status: 'pending' }),
      ]}
      typeById={typeById}
      onCancel={vi.fn()}
    />);
    const hasCancel = (id) => within(screen.getByTestId(`my-request-${id}`)).queryByRole('button', { name: 'Cancel' }) !== null;
    expect(hasCancel(1)).toBe(true);
    expect(hasCancel(2)).toBe(false);
    expect(hasCancel(3)).toBe(false);
    expect(hasCancel(4)).toBe(true);
  });

  test('cancelling asks first, inline, and "Keep it" leaves it alone', async () => {
    const onCancel = vi.fn().mockResolvedValue();
    render(<MyRequestsList requests={[row({ id: 1 })]} typeById={typeById} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('group', { name: 'Confirm cancel' });
    expect(confirm).toHaveTextContent('It came from Vacation Tracker');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 1 })));
  });

  test('a cancelled Vacation Tracker leave that is still there says so on its row', () => {
    render(<MyRequestsList requests={[row({ id: 5, status: 'cancelled', stillInVacationTracker: true }), row({ id: 6, status: 'cancelled', stillInVacationTracker: false })]} typeById={typeById} onCancel={vi.fn()} />);
    expect(screen.getByTestId('still-in-vt-5')).toHaveTextContent('Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.');
    expect(screen.queryByTestId('still-in-vt-6')).toBeNull();
  });
});

describe('#2 what My time says after the cancel', () => {
  const me = { leaveTypes: types, balances: [], settings: {} };
  const cancelThrough = async (response) => {
    api.myRequests.mockResolvedValue({ data: [row({ id: 1 })] });
    api.cancelRequest.mockResolvedValue({ data: response });
    const toast = vi.fn();
    render(<MyTimePanel me={me} toast={toast} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    return toast;
  };

  test('when Vacation Tracker could not be updated', async () => {
    const toast = await cancelThrough({ id: 1, status: 'cancelled', vacationTracker: { updated: false, message: 'Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.' } });
    expect(api.cancelRequest).toHaveBeenCalledWith(1);
    expect(toast).toHaveBeenCalledWith('Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.', 'amber');
  });

  test('when it was cancelled in both', async () => {
    const toast = await cancelThrough({ id: 1, status: 'cancelled', vacationTracker: { updated: true } });
    expect(toast).toHaveBeenCalledWith('Cancelled here and in Vacation Tracker');
  });
});

describe('#1 Settings → Import', () => {
  test('shows when the automatic import last ran for the workspace', async () => {
    api.vtImportStatus.mockResolvedValue({ data: { automatic: true, everyMinutes: 15, workspaces: { 1: { auto: { at: '2026-11-09T18:04:00.000Z', ok: true, created: 1, updated: 0, cancelled: 1 } } } } });
    render(<ImportSection toast={vi.fn()} />);
    const line = await screen.findByTestId('vt-auto-import');
    expect(line).toHaveTextContent(/^Last imported automatically .*\(1 new, 0 changed, 1 cancelled\)\. Runs every 15 minutes\.$/);
  });

  test('says when it is off, has not run yet, or failed', () => {
    const { rerender } = render(<AutoImportLine status={{ automatic: false }} workspaceId={1} />);
    expect(screen.getByTestId('vt-auto-import')).toHaveTextContent('The automatic import is off on this server');
    rerender(<AutoImportLine status={{ automatic: true, everyMinutes: 15, workspaces: {} }} workspaceId={1} />);
    expect(screen.getByTestId('vt-auto-import')).toHaveTextContent('It has not run for this workspace yet');
    rerender(<AutoImportLine status={{ automatic: true, everyMinutes: 15, workspaces: { 1: { auto: { at: '2026-11-09T18:04:00.000Z', ok: false, error: 'Vacation Tracker API error (503)' } } } }} workspaceId={1} />);
    expect(screen.getByTestId('vt-auto-import')).toHaveTextContent(/could not run .*Vacation Tracker API error \(503\)/);
  });
});
