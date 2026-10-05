/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Availability (native Vacation Tracker replacement): My time (balances, live
// verdict, booking), Team calendar, Approvals and the admin-only Settings tab.

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
// The booking form starts on the next working day (today, or Monday at a weekend).
const NEXT_WORKDAY = (() => {
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const TYPES = [
  { id: 1, key: 'vacation', name: 'Vacation', color: 'emerald', unit: 'day', allowHalfDays: true, requiresApproval: true, availability: 'OFF', visibility: 'public', requiresNote: false, tracksBalance: true, sortOrder: 10, isActive: true },
  { id: 2, key: 'wfh', name: 'Working from home', color: 'sky', unit: 'day', allowHalfDays: true, requiresApproval: false, availability: 'WFH', visibility: 'public', requiresNote: false, tracksBalance: false, sortOrder: 30, isActive: true },
];

const baseMe = (over = {}) => ({
  person: { id: 7, email: 'kim@x.ca', name: 'Kim Lee', officeId: 1, workdays: [1, 2, 3, 4, 5], dailyHours: 8 },
  settings: { yearStartMonth: 1, outlookEventsEnabled: false, autoRepliesEnabled: false, purposeNotice: 'We record time away for scheduling only.' },
  leaveTypes: TYPES,
  offices: [{ id: 1, name: 'Vancouver', province: 'BC', timezone: 'America/Vancouver' }],
  balances: [{ leaveTypeId: 1, name: 'Vacation', year: now.getFullYear(), entitled: 15, adjustments: 0, taken: 3, scheduled: 2, pending: 1, remaining: 9 }],
  isAdmin: false,
  pendingApprovals: 0,
  ...over,
});

const PREVIEWS = {
  approved: { outcome: 'approved', reason: 'Working from home does not need approval.', fired: [], warnings: [], days: 1, hours: 8, dates: [TODAY], remaining: null },
  pending: { outcome: 'pending', reason: 'Vacation needs approval.', fired: [], warnings: [{ ruleId: 4, name: 'Busy week', outcome: 'warn', message: 'Two others are away that week.' }], days: 3, hours: 24, dates: [], remaining: 6 },
  refused: { outcome: 'refused', reason: 'It overlaps a blackout period (2026-12-20 to 2026-12-31): Year end.', fired: [{ ruleId: 9, name: 'Year end', outcome: 'refuse', message: 'It overlaps a blackout period (2026-12-20 to 2026-12-31): Year end.' }], warnings: [], days: 2, hours: 16, dates: [], remaining: 7 },
};

let me = baseMe();
let previewKind = 'pending';
const api = vi.hoisted(() => ({}));
Object.assign(api, {
  me: vi.fn(async () => ({ success: true, data: me })),
  myRequests: vi.fn(async () => ({ success: true, data: [
    { id: 31, email: 'kim@x.ca', leaveTypeId: 1, startDate: '2099-07-06', endDate: '2099-07-10', dayPart: 'full', days: 5, hours: 40, status: 'approved', decision: { outcome: 'approved', reason: 'Approved by Pat' }, note: null },
    { id: 30, email: 'kim@x.ca', leaveTypeId: 2, startDate: '2020-01-06', endDate: '2020-01-06', dayPart: 'am', days: 0.5, hours: 4, status: 'approved', decision: null, note: null },
  ] })),
  preview: vi.fn(async () => ({ success: true, data: PREVIEWS[previewKind] })),
  createRequest: vi.fn(async (body) => ({ success: true, data: { id: 99, ...body, status: 'pending' } })),
  cancelRequest: vi.fn(async () => ({ success: true, data: {} })),
  calendar: vi.fn(async () => ({ success: true, data: {
    from: TODAY, to: TODAY,
    people: [{ email: 'kim@x.ca', name: 'Kim Lee', officeId: 1 }, { email: 'pat@x.ca', name: 'Pat Ruiz', officeId: 1 }],
    entries: [{ id: 5, email: 'pat@x.ca', startDate: TODAY, endDate: TODAY, dayPart: 'full', status: 'approved', leaveTypeId: 1, label: 'Vacation', color: 'emerald', availability: 'OFF' }],
    holidays: [],
  } })),
  outToday: vi.fn(async () => ({ success: true, data: [{ id: 5, email: 'pat@x.ca', startDate: TODAY, endDate: TODAY, dayPart: 'full', status: 'approved', label: 'Vacation', color: 'emerald' }] })),
  roster: vi.fn(async () => ({ success: true, data: { people: [{ email: 'kim@x.ca', name: 'Kim Lee', officeId: 1, photoUrl: null, groupIds: [] }, { email: 'pat@x.ca', name: 'Pat Ruiz', officeId: 1, photoUrl: null, groupIds: [] }], groups: [], offices: [{ id: 1, name: 'Vancouver' }] } })),
  upcomingHolidays: vi.fn(async () => ({ success: true, data: [] })),
  approvals: vi.fn(async () => ({ success: true, data: [
    { id: 41, email: 'jo.smith@x.ca', leaveTypeId: 1, startDate: '2099-03-02', endDate: '2099-03-06', dayPart: 'full', days: 5, hours: 40, status: 'pending', note: 'Family trip', decision: { outcome: 'pending', reason: 'Vacation needs approval.', fired: [] } },
    { id: 42, email: 'ali.k@x.ca', leaveTypeId: 1, startDate: '2099-04-01', endDate: '2099-04-01', dayPart: 'full', days: 1, hours: 8, status: 'pending', note: null, decision: { outcome: 'pending', reason: 'Less than 14 days notice.', fired: [] } },
  ] })),
  decide: vi.fn(async () => ({ success: true, data: {} })),
  adminConfig: vi.fn(async () => ({ success: true, data: {
    settings: { yearStartMonth: 1, outlookEventsEnabled: false, autoRepliesEnabled: false, purposeNotice: '' },
    leaveTypes: TYPES, offices: me.offices, groups: [], rules: [], people: [{ id: 7, email: 'kim@x.ca', name: 'Kim Lee', officeId: 1, workdays: [1, 2, 3, 4, 5], dailyHours: 8 }],
  } })),
});

vi.mock('../services/api', () => ({ get availabilityAPI() { return api; }, getWorkspaceId: () => 1 }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));

const { default: Availability } = await import('./Availability');

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/availability/:tab?" element={<Availability />} />
    </Routes>
  </MemoryRouter>,
);

const pickType = async (name) => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Leave type' }));
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
};

beforeEach(() => {
  vi.clearAllMocks();
  me = baseMe();
  previewKind = 'pending';
});
afterEach(() => cleanup());

describe('My time', () => {
  test('shows balances, the purpose notice and my requests', async () => {
    renderAt('/availability/my-time');
    const balances = await screen.findByTestId('availability-balances');
    expect(within(balances).getByText('9')).toBeInTheDocument();
    expect(balances).toHaveTextContent('of 15 · 3 taken · 2 booked · 1 pending');
    expect(screen.getByText('We record time away for scheduling only.')).toBeInTheDocument();
    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Past')).toBeInTheDocument();
    // No Outlook boxes while the admin switches are off.
    expect(screen.queryByLabelText('Add to my Outlook calendar')).not.toBeInTheDocument();
  });

  test('verdict: pending says it goes to approvers, with warnings and working days', async () => {
    renderAt('/availability/my-time');
    const verdict = await screen.findByTestId('availability-verdict', {}, { timeout: 2000 });
    expect(verdict).toHaveTextContent('Goes to your approvers');
    expect(verdict).toHaveTextContent('3 working days');
    expect(verdict).toHaveTextContent('Two others are away that week.');
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeEnabled();
  });

  test('verdict: approved automatically', async () => {
    previewKind = 'approved';
    renderAt('/availability/my-time');
    await screen.findByRole('combobox', { name: 'Leave type' });
    await pickType('Working from home');
    await waitFor(() => expect(screen.getByTestId('availability-verdict')).toHaveTextContent('Will be approved automatically'), { timeout: 2000 });
  });

  test('verdict: refused shows the reason and blocks submit', async () => {
    previewKind = 'refused';
    renderAt('/availability/my-time');
    const verdict = await screen.findByTestId('availability-verdict', {}, { timeout: 2000 });
    expect(verdict).toHaveTextContent('It overlaps a blackout period (2026-12-20 to 2026-12-31): Year end.');
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
  });

  test('submitting sends the request and offers Outlook boxes only when enabled', async () => {
    me = baseMe({ settings: { ...baseMe().settings, outlookEventsEnabled: true, autoRepliesEnabled: true } });
    renderAt('/availability/my-time');
    const outlook = await screen.findByLabelText('Add to my Outlook calendar');
    expect(outlook).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Morning' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Dentist after' } });
    fireEvent.click(outlook);
    await screen.findByTestId('availability-verdict', {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(api.createRequest).toHaveBeenCalled());
    expect(api.createRequest.mock.calls[0][0]).toEqual(expect.objectContaining({
      leaveTypeId: 1, startDate: NEXT_WORKDAY, endDate: NEXT_WORKDAY, dayPart: 'am', note: 'Dentist after', wantsOutlookEvent: true, wantsAutoReply: false,
    }));
    expect(await screen.findByTestId('availability-toast')).toHaveTextContent('Vacation sent to your approvers');
    await waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
  });

  test('a server refusal on submit shows inline', async () => {
    api.createRequest.mockRejectedValueOnce(new Error('At least 14 days notice is needed.'));
    renderAt('/availability/my-time');
    await screen.findByTestId('availability-verdict', {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At least 14 days notice is needed.');
  });

  test('cancel asks first', async () => {
    renderAt('/availability/my-time');
    const row = await screen.findByTestId('my-request-31');
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(api.cancelRequest).toHaveBeenCalledWith(31));
  });
});

describe('Overview (default) and Wallchart', () => {
  test('/availability opens the Overview with who is out this week', async () => {
    renderAt('/availability');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true'));
    const out = await screen.findByTestId('out-this-week');
    await waitFor(() => expect(within(out).getByText('Pat Ruiz')).toBeInTheDocument());
  });

  test('wallchart: a row per person and a bar for the leave', async () => {
    renderAt('/availability/calendar');
    expect(await screen.findByTestId('cal-row-kim@x.ca')).toBeInTheDocument();
    expect(screen.getByTestId('cal-row-pat@x.ca')).toBeInTheDocument();
    expect(await screen.findByTestId(`cal-bar-pat@x.ca-${TODAY}`)).toHaveAttribute('aria-label', expect.stringContaining('Pat Ruiz, Vacation'));
    expect(screen.queryByTestId(`cal-bar-kim@x.ca-${TODAY}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Only people who are away'));
    expect(screen.queryByTestId('cal-row-kim@x.ca')).not.toBeInTheDocument();
    expect(screen.getByTestId('cal-row-pat@x.ca')).toBeInTheDocument();
  });
});

describe('Approvals', () => {
  test('tab shows with the count; approve removes the row', async () => {
    me = baseMe({ pendingApprovals: 2 });
    renderAt('/availability/approvals');
    expect(await screen.findByRole('tab', { name: 'Approvals, 2 waiting' })).toBeInTheDocument();
    const row = await screen.findByTestId('approval-41');
    expect(row).toHaveTextContent('Jo Smith');
    expect(row).toHaveTextContent('Family trip');
    expect(row).toHaveTextContent('Vacation needs approval.');
    fireEvent.click(within(row).getByRole('button', { name: "Approve Jo Smith's request" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(41, 'approve', undefined));
    await waitFor(() => expect(screen.queryByTestId('approval-41')).not.toBeInTheDocument());
    expect(screen.getByTestId('availability-toast')).toHaveTextContent("Approved Jo Smith's request");
  });

  test('deny requires a note', async () => {
    me = baseMe({ pendingApprovals: 2 });
    renderAt('/availability/approvals');
    const row = await screen.findByTestId('approval-42');
    fireEvent.click(within(row).getByRole('button', { name: "Deny Ali K's request" }));
    fireEvent.click(within(row).getByRole('button', { name: 'Deny request' }));
    expect(within(row).getByRole('alert')).toHaveTextContent('Add a note so they know why');
    expect(api.decide).not.toHaveBeenCalled();
    fireEvent.change(within(row).getByLabelText("Reason for denying Ali K's request"), { target: { value: 'Release week' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Deny request' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith(42, 'deny', 'Release week'));
    await waitFor(() => expect(screen.queryByTestId('approval-42')).not.toBeInTheDocument());
  });
});

describe('Settings visibility', () => {
  test('non-admins see no Settings or Approvals tab and are sent back to the Overview', async () => {
    renderAt('/availability/settings');
    // The redirect re-renders the page; wait for the settled state.
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['Overview', 'Wallchart', 'Calendar', 'My time']);
    expect(api.adminConfig).not.toHaveBeenCalled();
  });

  test('admins get Settings with the leave types', async () => {
    me = baseMe({ isAdmin: true });
    renderAt('/availability/settings');
    expect(await screen.findByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Leave types' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Vacation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(await screen.findAllByText('Each person still confirms on every request; needs Microsoft Graph consent before turning on.')).toHaveLength(2);
  });
});
