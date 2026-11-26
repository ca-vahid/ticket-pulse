/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * Vacation Pulse, 26 Nov 2026:
 *   - Settings → Leave types: super admins keep the shared list and choose
 *     where each type is used ("Used in"); a workspace admin sees the list
 *     read-only with "Use in <workspace>" switches;
 *   - shared settings (offices, general, rules for everyone) are read-only
 *     for a workspace admin: "Only super admins change shared settings";
 *   - Settings → Recent changes, in plain words;
 *   - the booking form offers only the types available in the workspace.
 * Invented people and workspaces only.
 */

const api = vi.hoisted(() => ({
  saveLeaveType: vi.fn(),
  setLeaveTypeWorkspace: vi.fn(),
  settingsChanges: vi.fn(),
  saveOffice: vi.fn(),
  updateSettings: vi.fn(),
  saveRule: vi.fn(),
  deleteRule: vi.fn(),
  preview: vi.fn(),
  createRequest: vi.fn(),
  updateRequest: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));

const { default: LeaveTypesSection, usedInSummary } = await import('./admin/LeaveTypesSection');
const { default: RecentChangesSection, describeChange } = await import('./admin/RecentChangesSection');
const { default: OfficesSection } = await import('./admin/OfficesSection');
const { default: GeneralSection } = await import('./admin/GeneralSection');
const { default: RulesSection } = await import('./admin/RulesSection');
const { default: BookTimeForm } = await import('./BookTimeForm');

const TYPES = [
  { id: 1, name: 'Vacation', color: 'emerald', unit: 'day', allowHalfDays: true, availability: 'OFF', requiresApproval: true, isActive: true, sortOrder: 10 },
  { id: 3, name: 'Working from home', color: 'sky', unit: 'day', allowHalfDays: true, availability: 'WFH', requiresApproval: false, isActive: true, sortOrder: 30 },
  { id: 4, name: 'Site visit', color: 'amber', unit: 'day', allowHalfDays: true, availability: 'ONSITE', requiresApproval: false, isActive: true, sortOrder: 40 },
];
const NORTH = { id: 5, name: 'North Desk' };
const SOUTH = { id: 9, name: 'South Desk' };

const superConfig = () => ({
  leaveTypes: TYPES,
  typeAccess: { canEditTypes: true, workspaces: [NORTH, SOUTH], toggles: [{ leaveTypeId: 3, workspaceId: 9, enabled: false }] },
});
const leadConfig = (extra = {}) => ({
  leaveTypes: TYPES,
  typeAccess: { canEditTypes: false, workspaces: [NORTH], toggles: [{ leaveTypeId: 4, workspaceId: 5, enabled: false }] },
  ...extra,
});

beforeEach(() => {
  api.saveLeaveType.mockResolvedValue({ data: { id: 3 } });
  api.setLeaveTypeWorkspace.mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Leave types, super admin', () => {
  test('the "Used in" column names where a type is switched off', () => {
    render(<LeaveTypesSection config={superConfig()} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByRole('columnheader', { name: 'Used in' })).toBeInTheDocument();
    expect(screen.getByTestId('used-in-3')).toHaveTextContent('All but South Desk');
    expect(screen.getByTestId('used-in-1')).toHaveTextContent('Everywhere');
    expect(screen.getByRole('button', { name: /New type/ })).toBeInTheDocument();
    expect(screen.queryByTestId('shared-note')).not.toBeInTheDocument();
  });

  test('the drawer chooses where a type is used; Save sends only the switch that changed', async () => {
    const reload = vi.fn();
    render(<LeaveTypesSection config={superConfig()} reload={reload} toast={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Working from home' }));
    const usedIn = screen.getByTestId('type-used-in');
    const south = within(usedIn).getByRole('switch', { name: 'South Desk' });
    expect(south).not.toBeChecked();
    expect(within(usedIn).getByRole('switch', { name: 'North Desk' })).toBeChecked();
    fireEvent.click(south);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setLeaveTypeWorkspace).toHaveBeenCalledWith(3, 9, true));
    expect(api.setLeaveTypeWorkspace).toHaveBeenCalledTimes(1);
    expect(api.saveLeaveType).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: 'Working from home' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  test('usedInSummary lists each place it is switched off', () => {
    const isOn = (t, w) => !(t === 3 && [5, 9].includes(w));
    expect(usedInSummary(3, [NORTH, SOUTH], isOn)).toBe('Nowhere');
    expect(usedInSummary(1, [NORTH, SOUTH], isOn)).toBe('Everywhere');
    expect(usedInSummary(3, [NORTH, SOUTH, { id: 2, name: 'West Desk' }], isOn)).toBe('All but North Desk, South Desk');
  });
});

describe('Leave types, workspace admin', () => {
  test('the shared list is read-only, with a "Use in" switch per type and the one-line explanation', () => {
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /New type/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.getByTestId('shared-note')).toHaveTextContent('Only super admins change shared settings.');
    expect(screen.getByRole('columnheader', { name: 'Use in North Desk' })).toBeInTheDocument();
    expect(screen.getByTestId('ws-switch-hint')).toHaveTextContent('Switching a type off here hides it only for North Desk.');
    expect(screen.getByRole('switch', { name: 'Use Site visit in North Desk' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use Working from home in North Desk' })).toBeChecked();
    // Never "team" or "workspace": the place is called by its name.
    expect(screen.getByRole('region', { name: 'Leave types' })).not.toHaveTextContent(/\bteams?\b|\bworkspaces?\b/i);
  });

  test('a switch saves at once for that workspace and says so', async () => {
    const toast = vi.fn();
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={toast} />);
    const wfh = screen.getByRole('switch', { name: 'Use Working from home in North Desk' });
    fireEvent.click(wfh);
    await waitFor(() => expect(api.setLeaveTypeWorkspace).toHaveBeenCalledWith(3, 5, false));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Working from home turned off for North Desk'));
    expect(wfh).not.toBeChecked();
  });

  test('a refused switch goes back and says why', async () => {
    api.setLeaveTypeWorkspace.mockRejectedValueOnce(new Error('You can switch leave types on or off for the workspaces you administer'));
    render(<LeaveTypesSection config={leadConfig()} reload={vi.fn()} toast={vi.fn()} />);
    const wfh = screen.getByRole('switch', { name: 'Use Working from home in North Desk' });
    fireEvent.click(wfh);
    expect(await screen.findByRole('alert')).toHaveTextContent(/workspaces you administer/);
    expect(wfh).toBeChecked();
  });
});

describe('shared settings are read-only for a workspace admin', () => {
  const OFFICES = [{ id: 12, name: 'North Office', province: 'BC', timezone: 'America/Vancouver', isActive: true }];

  test('offices: no new or edit, and the note', () => {
    render(<OfficesSection config={leadConfig({ offices: OFFICES, people: [] })} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByTestId('shared-note')).toHaveTextContent('Only super admins change shared settings.');
    expect(screen.queryByRole('button', { name: /New office/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit North Office' })).not.toBeInTheDocument();
  });

  test('offices: a super admin still edits them', () => {
    render(<OfficesSection config={{ ...superConfig(), offices: OFFICES, people: [] }} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.queryByTestId('shared-note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit North Office' })).toBeInTheDocument();
  });

  test('general: every control is disabled and there is nothing to save', () => {
    render(<GeneralSection config={leadConfig({ settings: { yearStartMonth: 1, purposeNotice: 'Why we record time away' } })} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByTestId('shared-note')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Purpose notice' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  test('rules: a rule for everyone is read-only; a rule for one person can still be changed', () => {
    const rules = [
      { id: 1, name: 'Everyone needs notice', scopeType: 'company', scopeRef: null, condition: { kind: 'always' }, outcome: 'needs_approval', priority: 10, isActive: true },
      { id: 2, name: 'One person', scopeType: 'person', scopeRef: 'a.person@example.com', condition: { kind: 'always' }, outcome: 'needs_approval', priority: 20, isActive: true },
    ];
    render(<RulesSection config={leadConfig({ rules, offices: [], groups: [], people: [] })} reload={vi.fn()} toast={vi.fn()} />);
    expect(screen.getByTestId('shared-note')).toHaveTextContent('Only super admins change shared settings.');
    expect(screen.queryByRole('button', { name: 'Edit Everyone needs notice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Everyone needs notice' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit One person' })).toBeInTheDocument();
  });
});

describe('Recent changes', () => {
  const CHANGES = [
    { id: 3, createdAt: '2099-11-26T17:05:00.000Z', actor: 'lead@example.com', actorName: 'Lee Lead', workspaceId: 5, workspaceName: 'North Desk', entity: 'leave_type_workspace', entityId: '3', entityName: 'Working from home', action: 'disable', before: { enabled: true }, after: { enabled: false } },
    { id: 2, createdAt: '2099-11-26T16:00:00.000Z', actor: 'super@example.com', actorName: 'Sam Super', workspaceId: null, entity: 'leave_type', entityId: '1', entityName: 'Vacation', action: 'update', before: { allowPastDated: true }, after: { allowPastDated: false } },
    { id: 1, createdAt: '2099-11-26T15:00:00.000Z', actor: 'super@example.com', actorName: null, workspaceId: null, entity: 'approval_group', entityId: '8', entityName: 'Field crew', action: 'update', before: { members: ['a.person@example.com'] }, after: { members: ['a.person@example.com', 'b.person@example.com'] } },
  ];

  test('who and what, in plain words', async () => {
    api.settingsChanges.mockResolvedValue({ data: { changes: CHANGES, page: 1, pageSize: 50, hasMore: false } });
    render(<RecentChangesSection />);
    const list = await screen.findByTestId('recent-changes');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Lee Lead turned off Working from home for North Desk');
    expect(rows[1]).toHaveTextContent('Sam Super changed Vacation: allow past dates off');
    // No name on record: the e-mail.
    expect(rows[2]).toHaveTextContent('super@example.com changed Field crew: added B Person as a member');
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

  test('the other kinds of change', () => {
    expect(describeChange({ entity: 'settings', entityId: 'vacation_tracker', action: 'retire_vacation_tracker' })).toBe('retired Vacation Tracker');
    expect(describeChange({ entity: 'settings', entityId: '1', action: 'update', before: { outlookEventsEnabled: false }, after: { outlookEventsEnabled: true } })).toBe('changed the general settings: Outlook events on');
    expect(describeChange({ entity: 'calendar_import', workspaceName: 'North Desk', action: 'update', after: { mode: 'shadow' } })).toBe('set the shared calendar import for North Desk to shadow');
    expect(describeChange({ entity: 'rule', entityName: 'Two at most', action: 'delete' })).toBe('deleted the rule Two at most');
    expect(describeChange({ entity: 'leave_type', entityName: 'Site visit', action: 'deactivate', after: { isActive: false } })).toBe('retired the leave type Site visit');
    expect(describeChange({ entity: 'office', entityName: 'North Office', action: 'update', before: { timezone: 'America/Vancouver' }, after: { timezone: 'America/Edmonton' } })).toBe('changed North Office: time zone America/Edmonton');
    expect(describeChange({ entity: 'person', entityName: 'A Person', action: 'update', after: { entitlementOverrides: { 1: 15 } } })).toBe('changed A Person: allowances');
  });
});

describe('the booking form', () => {
  const ME = {
    leaveTypes: TYPES.map((t) => ({ ...t, bookable: t.id !== 4 })),
    settings: {},
  };

  test('a type not available in the person\'s workspace is not offered', () => {
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
