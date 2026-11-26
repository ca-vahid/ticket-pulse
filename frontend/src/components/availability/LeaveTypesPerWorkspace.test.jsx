/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Vacation Pulse, 26 Nov 2026:
 *   - Settings → Leave types: super admins keep the shared list and switch a
 *     type per team in its drawer; a workspace admin sees the list read-only
 *     with "Use in <workspace>" switches;
 *   - Settings → Recent changes, in plain words;
 *   - the booking form offers only the types the person can book.
 * Invented people and workspaces only.
 */

const api = vi.hoisted(() => ({
  saveLeaveType: vi.fn(),
  setLeaveTypeWorkspace: vi.fn(),
  settingsChanges: vi.fn(),
  preview: vi.fn(),
  createRequest: vi.fn(),
  updateRequest: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));

const { default: LeaveTypesSection, teamsSummary } = await import('./admin/LeaveTypesSection');
const { default: RecentChangesSection, changeHeadline, changeDetails } = await import('./admin/RecentChangesSection');
const { default: BookTimeForm } = await import('./BookTimeForm');

const TYPES = [
  { id: 1, name: 'Vacation', color: 'emerald', unit: 'day', allowHalfDays: true, availability: 'OFF', requiresApproval: true, isActive: true, sortOrder: 10 },
  { id: 3, name: 'Working from home', color: 'sky', unit: 'day', allowHalfDays: true, availability: 'WFH', requiresApproval: false, isActive: true, sortOrder: 30 },
  { id: 4, name: 'Site visit', color: 'amber', unit: 'day', allowHalfDays: true, availability: 'ONSITE', requiresApproval: false, isActive: true, sortOrder: 40 },
];
const FIVE = { id: 5, name: 'Team Five' };
const NINE = { id: 9, name: 'Team Nine' };

const superConfig = () => ({
  leaveTypes: TYPES,
  typeAccess: { canEditTypes: true, workspaces: [FIVE, NINE], toggles: [{ leaveTypeId: 3, workspaceId: 9, enabled: false }] },
});
const leadConfig = () => ({
  leaveTypes: TYPES,
  typeAccess: { canEditTypes: false, workspaces: [FIVE], toggles: [{ leaveTypeId: 4, workspaceId: 5, enabled: false }] },
});

beforeEach(() => {
  api.saveLeaveType.mockResolvedValue({ data: { id: 3 } });
  api.setLeaveTypeWorkspace.mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Leave types, super admin', () => {
  test('the Teams column says where a type is off', () => {
    render(<LeaveTypesSection config={superConfig()} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByTestId('teams-3')).toHaveTextContent('Off for Team Nine');
    expect(screen.getByTestId('teams-1')).toHaveTextContent('Every team');
    expect(screen.getByRole('button', { name: /New type/ })).toBeInTheDocument();
  });

  test('the drawer switches a type per team; Save sends only the switch that changed', async () => {
    const reload = vi.fn();
    const toast = vi.fn();
    render(<LeaveTypesSection config={superConfig()} reload={reload} toast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Working from home' }));
    const teams = screen.getByTestId('type-teams');
    const nine = within(teams).getByRole('switch', { name: 'Team Nine' });
    expect(nine).not.toBeChecked();
    expect(within(teams).getByRole('switch', { name: 'Team Five' })).toBeChecked();
    fireEvent.click(nine);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setLeaveTypeWorkspace).toHaveBeenCalledWith(3, 9, true));
    expect(api.setLeaveTypeWorkspace).toHaveBeenCalledTimes(1);
    expect(api.saveLeaveType).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: 'Working from home' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  test('teamsSummary reads naturally', () => {
    const isOn = (t, w) => !(t === 3 && [5, 9].includes(w));
    expect(teamsSummary(3, [FIVE, NINE], isOn)).toBe('Off for every team');
    expect(teamsSummary(1, [FIVE, NINE], isOn)).toBe('Every team');
    expect(teamsSummary(3, [FIVE, NINE, { id: 2, name: 'Two' }], isOn)).toBe('Off for Team Five and Team Nine');
  });
});

describe('Leave types, workspace admin', () => {
  test('the shared list is read-only, with a "Use in" switch per type and the one-line explanation', () => {
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /New type/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Use in Team Five' })).toBeInTheDocument();
    expect(screen.getByTestId('ws-switch-hint')).toHaveTextContent('Switching a type off here hides it only for Team Five.');
    expect(screen.getByRole('switch', { name: 'Use Site visit in Team Five' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use Working from home in Team Five' })).toBeChecked();
  });

  test('a switch saves at once for that workspace and says so', async () => {
    const toast = vi.fn();
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={toast} />);
    const wfh = screen.getByRole('switch', { name: 'Use Working from home in Team Five' });
    fireEvent.click(wfh);
    await waitFor(() => expect(api.setLeaveTypeWorkspace).toHaveBeenCalledWith(3, 5, false));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Working from home is off for Team Five'));
    expect(wfh).not.toBeChecked();
  });

  test('a refused switch goes back and says why', async () => {
    api.setLeaveTypeWorkspace.mockRejectedValueOnce(new Error('You can switch leave types on or off for the workspaces you administer'));
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={vi.fn()} />);
    const wfh = screen.getByRole('switch', { name: 'Use Working from home in Team Five' });
    fireEvent.click(wfh);
    expect(await screen.findByRole('alert')).toHaveTextContent(/workspaces you administer/);
    expect(wfh).toBeChecked();
  });
});

describe('Recent changes', () => {
  const CHANGES = [
    { id: 3, createdAt: '2099-11-26T17:05:00.000Z', actor: 'lead@example.com', actorName: 'Team Lead', workspaceId: 5, workspaceName: 'Team Five', entity: 'leave_type_workspace', entityId: '4', entityName: 'Site visit', action: 'disable', before: { enabled: true }, after: { enabled: false } },
    { id: 2, createdAt: '2099-11-26T16:00:00.000Z', actor: 'super@example.com', actorName: 'Super Admin', workspaceId: null, entity: 'leave_type', entityId: '3', entityName: 'Working from home', action: 'update', before: { requiresApproval: false }, after: { requiresApproval: true } },
    { id: 1, createdAt: '2099-11-26T15:00:00.000Z', actor: 'super@example.com', actorName: null, workspaceId: null, entity: 'approval_group', entityId: '8', entityName: 'Field crew', action: 'update', before: { members: ['a.person@example.com'] }, after: { members: ['a.person@example.com', 'b.person@example.com'] } },
  ];

  test('who, when and what, in plain words', async () => {
    api.settingsChanges.mockResolvedValue({ data: { changes: CHANGES, page: 1, pageSize: 50, hasMore: false } });
    render(<RecentChangesSection />);
    const list = await screen.findByTestId('recent-changes');
    const rows = within(list).getAllByRole('listitem').filter((li) => li.parentElement === list);
    expect(rows[0]).toHaveTextContent('Team Lead switched “Site visit” off for Team Five');
    expect(rows[1]).toHaveTextContent('Super Admin changed the leave type “Working from home”');
    expect(rows[1]).toHaveTextContent('Needs approval: off → on');
    expect(rows[2]).toHaveTextContent('changed the approval group “Field crew”');
    expect(rows[2]).toHaveTextContent(/Members: added/);
    expect(api.settingsChanges).toHaveBeenCalledWith({ page: 1 });
  });

  test('pages of 50: Older asks for the next page', async () => {
    api.settingsChanges.mockResolvedValueOnce({ data: { changes: CHANGES, page: 1, pageSize: 50, hasMore: true } })
      .mockResolvedValueOnce({ data: { changes: [], page: 2, pageSize: 50, hasMore: false } });
    render(<RecentChangesSection />);
    await screen.findByTestId('recent-changes');
    fireEvent.click(screen.getByRole('button', { name: /Older/ }));
    await waitFor(() => expect(api.settingsChanges).toHaveBeenLastCalledWith({ page: 2 }));
    expect(await screen.findByText('Page 2')).toBeInTheDocument();
  });

  test('headlines for the other kinds of change', () => {
    expect(changeHeadline({ entity: 'settings', entityId: 'vacation_tracker', action: 'retire_vacation_tracker' })).toBe('retired Vacation Tracker');
    expect(changeHeadline({ entity: 'calendar_import', workspaceName: 'Team Five', action: 'update', after: { mode: 'shadow' } })).toBe('set the shared calendar import for Team Five to shadow');
    expect(changeHeadline({ entity: 'rule', entityName: 'Two at most', action: 'delete' })).toBe('deleted the rule “Two at most”');
    expect(changeDetails({ entity: 'office', action: 'update', before: { timezone: 'America/Vancouver' }, after: { timezone: 'America/Edmonton' } })).toEqual(['Time zone: America/Vancouver → America/Edmonton']);
  });
});

describe('the booking form', () => {
  const ME = {
    leaveTypes: TYPES.map((t) => ({ ...t, bookable: t.id !== 4 })),
    settings: {},
  };

  test('a type switched off for the person\'s team is not offered', () => {
    render(<BookTimeForm me={ME} />);
    expect(screen.getByRole('radio', { name: 'Vacation' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Working from home' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Site visit' })).not.toBeInTheDocument();
  });

  test('a waiting request of that type can still be changed', () => {
    const waiting = { id: 30, leaveTypeId: 4, startDate: '2099-11-12', endDate: '2099-11-12', dayPart: 'full', days: 1, status: 'pending', source: 'app', editable: true, siteOfficeId: null, siteLocation: 'North yard' };
    render(<BookTimeForm me={ME} editing={waiting} onStopEditing={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Site visit' })).toBeChecked();
  });
});
