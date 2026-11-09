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

const { default: BookTimeForm, DayStrip } = await import('./BookTimeForm');
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
    expect(screen.getByLabelText('Start date')).toHaveValue('2099-11-12');
    expect(screen.getByRole('radio', { name: 'Vacation' })).toBeChecked();

    // Unchanged: nothing to save yet.
    const save = screen.getByRole('button', { name: /Send changes for approval|Save changes/ });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2099-11-13' } });
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
    const start = screen.getByLabelText('Start date').value;
    const end = screen.getByLabelText('End date').value;
    expect(new Date(`${start}T12:00`).getDay()).toBe(1);
    expect(new Date(`${end}T12:00`).getDay()).toBe(5);
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

describe('my requests', () => {
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

  test('the row being changed is marked, and its Change button steps aside', () => {
    render(<MyRequestsList requests={[THU_FRI]} typeById={typeById} onCancel={vi.fn()} onEdit={vi.fn()} editingId={210} />);
    expect(screen.getByText('Changing…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Change Vacation/ })).not.toBeInTheDocument();
  });
});
