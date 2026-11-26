/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  createRequest: vi.fn(),
  updateRequest: vi.fn(),
}));
vi.mock('../../services/api', () => ({ availabilityAPI: api }));

const { default: BookTimeForm, DayStrip, SiteOfficeField } = await import('./BookTimeForm');
const { default: MyRequestsList } = await import('./MyRequestsList');

const ME = {
  leaveTypes: [
    { id: 1, name: 'Vacation', color: 'emerald', unit: 'day', allowHalfDays: true, sortOrder: 1 },
    { id: 2, name: 'Work from home', color: 'sky', unit: 'day', availability: 'WFH', sortOrder: 2 },
  ],
  settings: {},
};
// Gaby: Thu 12 + Fri 13 Nov, waiting for Vahid.
const THU_FRI = {
  id: 210, leaveTypeId: 1, startDate: '2099-11-12', endDate: '2099-11-13', dayPart: 'full', days: 2, status: 'pending',
  note: null, source: 'app', editable: true, waitingOn: [{ email: 'vahid@bgc.ca', name: 'Vahid Haeri' }],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.preview.mockResolvedValue({ data: { outcome: 'pending', days: 1, dates: ['2099-11-13T00:00:00.000Z'], reason: 'Vacation needs an approver' } });
  api.updateRequest.mockResolvedValue({ data: { id: 210, status: 'pending' } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const flushPreview = async () => { await act(async () => { vi.advanceTimersByTime(400); }); };

describe('changing a waiting request', () => {
  test('the form opens filled in, says who it waits for, and saves through the change endpoint', async () => {
    const onBooked = vi.fn();
    const toast = vi.fn();
    render(<BookTimeForm me={ME} editing={THU_FRI} onBooked={onBooked} toast={toast} onStopEditing={vi.fn()} />);
    expect(screen.getByRole('form', { name: 'Change your request' })).toBeInTheDocument();
    expect(screen.getByText(/waiting for Vahid Haeri/)).toBeInTheDocument();
    // The calendar opens on the request's month with its two days picked.
    expect(screen.getAllByRole('gridcell', { selected: true }).map((c) => c.dataset.day)).toEqual(['2099-11-12', '2099-11-13']);
    expect(screen.getByRole('radio', { name: 'Vacation' })).toBeChecked();

    // Unchanged: nothing to save yet.
    const save = screen.getByRole('button', { name: /Send changes for approval|Save changes/ });
    expect(save).toBeDisabled();

    // A tap after a finished pick starts over: Friday alone.
    fireEvent.click(screen.getByRole('gridcell', { name: /^\w+ 13 November/ }));
    await flushPreview();
    // The dry run leaves this request out of the counts.
    expect(api.preview).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 210, startDate: '2099-11-13', endDate: '2099-11-13' }));
    expect(await screen.findByText('The change goes to your approvers')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send changes for approval' }));
    await waitFor(() => expect(api.updateRequest).toHaveBeenCalledWith(210, expect.objectContaining({ leaveTypeId: 1, startDate: '2099-11-13', endDate: '2099-11-13', dayPart: 'full' })));
    expect(api.createRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(onBooked).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Your changes went to your approvers');
  });

  test('"Keep it as it was" leaves without saving', () => {
    const onStop = vi.fn();
    render(<BookTimeForm me={ME} editing={THU_FRI} onStopEditing={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it as it was' }));
    expect(onStop).toHaveBeenCalled();
    expect(api.updateRequest).not.toHaveBeenCalled();
  });
});

describe('booking anew', () => {
  test('types are a short list to tick, and quick picks fill the dates', async () => {
    render(<BookTimeForm me={ME} />);
    expect(screen.getByRole('form', { name: 'Book time away' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Work from home' }));
    expect(screen.getByText('Shows on the team calendar; you stay available.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    // Monday to Friday of next week (no holidays given here).
    expect(screen.getByTestId('pick-spoken')).toHaveTextContent(/^Mon .* to Fri .*, 5 working days$/);
  });
});

// 25 Nov 2026: a site visit says which office (or "Other site" with a short text).
describe('"Which office?" on a site visit', () => {
  const SITE_ME = {
    ...ME,
    leaveTypes: [...ME.leaveTypes, { id: 4, name: 'Site visit', color: 'amber', unit: 'day', availability: 'ONSITE', allowHalfDays: true, sortOrder: 3 }],
    offices: [
      { id: 2, name: 'Toronto', isActive: true },
      { id: 1, name: 'Vancouver', isActive: true },
      { id: 9, name: 'Old Depot', isActive: false },
    ],
  };
  beforeEach(() => {
    api.preview.mockResolvedValue({ data: { outcome: 'approved', days: 1, dates: [] } });
    api.createRequest.mockResolvedValue({ data: { id: 9001, status: 'approved' } });
  });
  // The card starts with no day picked (QA 11-25): pick today first.
  const pickToday = () => fireEvent.click(screen.getByRole('button', { name: 'Today' }));

  test('only a site visit asks; the active offices by name, then "Other site…"', () => {
    render(<BookTimeForm me={SITE_ME} />);
    expect(screen.queryByLabelText(/^Which office\?/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Site visit' }));
    const select = screen.getByLabelText(/^Which office\?/);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Pick an office…', 'Toronto', 'Vancouver', 'Other site…']);
    expect(select).toBeRequired();
  });

  test('booking without an office says so and sends nothing; with Toronto it sends the office', async () => {
    render(<BookTimeForm me={SITE_ME} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Site visit' }));
    pickToday();
    await flushPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Pick which office the site visit is at');
    expect(api.createRequest).not.toHaveBeenCalled();
    // The select is marked invalid and described by the error.
    const select = screen.getByLabelText(/^Which office\?/);
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select.getAttribute('aria-describedby').split(' ')).toContain(alert.id);
    expect(select).toHaveAccessibleDescription(/Pick which office the site visit is at/);

    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ leaveTypeId: 4, siteOfficeId: 2 })));
    expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty('siteLocation');
  });

  test('"Other site…" opens a short text box, and the text is what is sent', async () => {
    render(<BookTimeForm me={SITE_ME} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Site visit' }));
    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: 'other' } });
    const box = screen.getByLabelText(/^Which site\?/);
    expect(box).toHaveAttribute('maxLength', '160');
    pickToday();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Say which site you are visiting');
    // The "Which site?" box has a visible label, is marked invalid and described by the error.
    expect(screen.getByText('Which site? (required)').tagName).toBe('LABEL');
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAttribute('aria-describedby', alert.id);
    expect(screen.getByLabelText(/^Which office\?/)).not.toHaveAttribute('aria-invalid');
    fireEvent.change(box, { target: { value: '  Client plant, Kamloops ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ siteLocation: 'Client plant, Kamloops' })));
    expect(api.createRequest.mock.calls[0][0]).not.toHaveProperty('siteOfficeId');
  });

  test('choosing the place does not re-run the dry run', async () => {
    render(<BookTimeForm me={SITE_ME} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Site visit' }));
    pickToday();
    await flushPreview();
    const calls = api.preview.mock.calls.length;
    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: '1' } });
    await flushPreview();
    expect(api.preview.mock.calls.length).toBe(calls);
    expect(api.preview.mock.calls.at(-1)[0]).not.toHaveProperty('siteOfficeId');
  });

  test('changing an older site visit with no office: optional while type and dates stay, the header names the office when there is one', async () => {
    const older = { ...THU_FRI, id: 9030, leaveTypeId: 4, siteOfficeId: null, siteLocation: null };
    const { unmount } = render(<BookTimeForm me={SITE_ME} editing={older} onStopEditing={vi.fn()} />);
    expect(screen.getByLabelText(/^Which office\?/)).not.toBeRequired();
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Bring the badge' } });
    await flushPreview();
    fireEvent.click(screen.getByRole('button', { name: /Save changes|Send changes for approval/ }));
    await waitFor(() => expect(api.updateRequest).toHaveBeenCalledWith(9030, expect.objectContaining({ note: 'Bring the badge' })));
    unmount();

    render(<BookTimeForm me={SITE_ME} editing={{ ...older, id: 9031, siteOfficeId: 2 }} onStopEditing={vi.fn()} />);
    expect(screen.getByText(/Now: Site visit · Toronto/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Which office\?/)).toHaveValue('2');
  });
});

describe('the "Which office?" field on its own (props in)', () => {
  test('renders for a harness and reports changes', () => {
    const onChange = vi.fn();
    render(<SiteOfficeField offices={[{ id: 2, name: 'Toronto' }]} value="other" location="Client plant" onChange={onChange} />);
    expect(screen.getByLabelText(/^Which site\?/)).toHaveValue('Client plant');
    fireEvent.change(screen.getByLabelText(/^Which office\?/), { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith({ siteOfficeId: '2', siteLocation: '' });
  });
});

describe('the day strip', () => {
  test('counted days are filled; weekends and holidays are struck through', () => {
    // Fri 13 – Mon 16 Nov 2099; the server counts Fri only (Mon a holiday).
    render(<DayStrip startDate="2099-11-13" endDate="2099-11-16" counted={new Set(['2099-11-13'])} color="emerald" dayPart="full" />);
    const cells = screen.getByTestId('availability-day-strip').children;
    expect(cells).toHaveLength(4);
    expect(cells[0].className).toMatch(/bg-emerald-200/);
    for (const c of [cells[1], cells[2], cells[3]]) expect(c.className).toMatch(/line-through/);
  });
});

describe('my requests (the old list, kept for other callers)', () => {
  const typeById = new Map(ME.leaveTypes.map((t) => [t.id, t]));
  test('a waiting request offers Change and names who it waits for; an approved one does not', () => {
    const onEdit = vi.fn();
    const approved = { ...THU_FRI, id: 211, status: 'approved', waitingOn: undefined, editable: undefined };
    render(<MyRequestsList requests={[THU_FRI, approved]} typeById={typeById} onCancel={vi.fn()} onEdit={onEdit} />);
    expect(screen.getAllByText('Waiting for Vahid Haeri')).toHaveLength(1);
    const change = screen.getAllByRole('button', { name: /^Change Vacation/ });
    expect(change).toHaveLength(1);
    fireEvent.click(change[0]);
    expect(onEdit).toHaveBeenCalledWith(THU_FRI);
  });

  test('a site visit reads "Site visit · Toronto" (or its other site)', () => {
    const types = new Map([[4, { id: 4, name: 'Site visit', color: 'amber' }]]);
    const rows = [
      { ...THU_FRI, id: 9032, leaveTypeId: 4, status: 'approved', siteOfficeId: 2, sitePlace: null },
      { ...THU_FRI, id: 9033, leaveTypeId: 4, status: 'approved', siteLocation: 'Client plant, Kamloops', startDate: '2099-11-20', endDate: '2099-11-20' },
    ];
    render(<MyRequestsList requests={rows} typeById={types} onCancel={vi.fn()} offices={[{ id: 2, name: 'Toronto' }]} />);
    expect(screen.getByText('Site visit · Toronto')).toBeInTheDocument();
    expect(screen.getByText('Site visit · Client plant, Kamloops')).toBeInTheDocument();
  });

  test('the row being changed is marked, and its Change button steps aside', () => {
    render(<MyRequestsList requests={[THU_FRI]} typeById={typeById} onCancel={vi.fn()} onEdit={vi.fn()} editingId={210} />);
    expect(screen.getByText('Changing…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change Vacation/ })).not.toBeInTheDocument();
  });
});
