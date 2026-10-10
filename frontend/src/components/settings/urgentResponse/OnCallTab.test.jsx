/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ON_CALL, SETTINGS, TECHS, ok } from './urgentResponse.fixtures';

// On-call tab: the order (up / down / add / remove), the 8-week rows, a week
// that needs cover, and the two ways to settle it: set the cover, or ask.

const api = vi.hoisted(() => ({}));
vi.mock('../../../services/api', () => ({ get urgentResponseAPI() { return api; } }));
vi.mock('../../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));

const { default: OnCallTab } = await import('./OnCallTab');

function setup(props = {}) {
  const onSaved = vi.fn();
  const reloadOnCall = vi.fn(async () => {});
  render(
    <OnCallTab
      settings={SETTINGS}
      technicians={TECHS}
      techById={new Map(TECHS.map((t) => [t.id, t]))}
      onCall={ON_CALL}
      reloadOnCall={reloadOnCall}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onSaved, reloadOnCall };
}

// The name without the avatar's initials.
const orderNames = () => within(screen.getByRole('region', { name: 'Order' })).getAllByRole('listitem').map((li) => li.querySelector('.truncate').textContent);
const optionLabels = () => screen.getAllByRole('option').map((o) => o.querySelector('span[title]').getAttribute('title'));
const weekRows = () => screen.getAllByTestId('on-call-week');
const saveButton = () => screen.getByRole('button', { name: 'Save' });

beforeEach(() => {
  // Only the clock is faked: "now" is in the first week, before the leave days.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T18:00:00Z'));
  Object.assign(api, {
    updateSettings: vi.fn(async (patch) => ok({ settings: { ...SETTINGS, ...patch }, changes: [] })),
    createCover: vi.fn(async () => ok({ id: 20 })),
    cancelCover: vi.fn(async () => ok({})),
    createCoverRequest: vi.fn(async () => ok({ id: 30 })),
    cancelCoverRequest: vi.fn(async () => ok({})),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('Urgent response: On-call', () => {
  test('says who is on call now, until when, and that covering never changes the order', () => {
    setup();
    const now = screen.getByTestId('on-call-now');
    expect(now).toHaveTextContent('David Zapata');
    expect(now).toHaveTextContent('until Mon 19 Oct, 17:00');
    expect(screen.getByText('When someone covers, the long-term order below never changes.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Handover day' })).toHaveTextContent('Monday');
    expect(screen.getByLabelText('Handover time')).toHaveValue('17:00');
  });

  test('the order moves up and down, people are added and removed, and Save sends the new order', async () => {
    const { onSaved, reloadOnCall } = setup();
    expect(orderNames()).toEqual(['David Zapata', 'Andrew Fong', 'Maria Lee']);
    expect(screen.getByRole('button', { name: 'Move David Zapata up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Maria Lee down' })).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Maria Lee up' }));
    expect(orderNames()).toEqual(['David Zapata', 'Maria Lee', 'Andrew Fong']);
    fireEvent.click(screen.getByRole('button', { name: 'Move David Zapata down' }));
    expect(orderNames()).toEqual(['Maria Lee', 'David Zapata', 'Andrew Fong']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Andrew Fong' }));
    expect(orderNames()).toEqual(['Maria Lee', 'David Zapata']);

    fireEvent.click(screen.getByRole('combobox', { name: 'Add a person to the order' }));
    // Only active people who are not in the order yet.
    expect(optionLabels()).toEqual(['Andrew Fong', 'Susan Xu']);
    fireEvent.click(screen.getByRole('option', { name: 'Susan Xu' }));
    expect(orderNames()).toEqual(['Maria Lee', 'David Zapata', 'Susan Xu']);

    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallOrder: [3, 1, 4] }));
    await waitFor(() => expect(reloadOnCall).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ onCallOrder: [3, 1, 4] }), { orderSaved: true });
  });

  test('handover day and time are part of the same Save', async () => {
    setup();
    fireEvent.click(screen.getByRole('combobox', { name: 'Handover day' }));
    fireEvent.click(screen.getByRole('option', { name: 'Friday' }));
    fireEvent.change(screen.getByLabelText('Handover time'), { target: { value: '16:30' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallHandoverDay: 5, onCallHandoverTime: '16:30' }));
  });

  test('an order taken from the old escalation settings is unsaved until Save', async () => {
    const { onSaved } = setup({ orderSuggested: true });
    expect(screen.getByTestId('order-suggested')).toHaveTextContent('This order was taken from the old escalation settings. It is saved when you press Save.');
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    // A first order also says who is on call this week; the start date is the server's.
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallOrder: [1, 2, 3], onCallCurrentTechnicianId: 1 }));
    expect(onSaved).toHaveBeenCalledWith(expect.anything(), { orderSaved: true });
  });

  test('a first order with no schedule yet starts from the first person, or from the one picked', async () => {
    setup({ settings: { ...SETTINGS, onCallOrder: [] }, onCall: { ...ON_CALL, current: null, weeks: [] } });
    expect(screen.queryByRole('combobox', { name: 'On call this week' })).not.toBeInTheDocument();
    for (const name of ['Maria Lee', 'Susan Xu']) {
      fireEvent.click(screen.getByRole('combobox', { name: 'Add a person to the order' }));
      fireEvent.click(screen.getByRole('option', { name }));
    }
    const week = screen.getByRole('combobox', { name: 'On call this week' });
    expect(week).toHaveTextContent('Maria Lee');
    fireEvent.click(week);
    fireEvent.click(screen.getByRole('option', { name: 'Susan Xu' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallOrder: [3, 4], onCallCurrentTechnicianId: 4 }));
  });

  test('"On call this week" starts on the scheduled person and is sent only when it changes', async () => {
    setup();
    const week = screen.getByRole('combobox', { name: 'On call this week' });
    expect(week).toHaveTextContent('David Zapata');
    expect(screen.getByText('The order repeats every week from this person. Covers never change it.')).toBeInTheDocument();
    fireEvent.click(week);
    // Only the people in the order.
    expect(optionLabels()).toEqual(['David Zapata', 'Andrew Fong', 'Maria Lee']);
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallCurrentTechnicianId: 3 }));
    expect(Object.keys(api.updateSettings.mock.calls[0][0])).not.toContain('onCallAnchorDate');
  });

  test('picking the scheduled person again is not a change', () => {
    setup();
    fireEvent.click(screen.getByRole('combobox', { name: 'On call this week' }));
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'On call this week' }));
    fireEvent.click(screen.getByRole('option', { name: 'David Zapata' }));
    expect(saveButton()).toBeDisabled();
  });

  test('removing this week’s person from the order says who takes the week', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove David Zapata' }));
    expect(screen.getByRole('combobox', { name: 'On call this week' })).toHaveTextContent('Andrew Fong');
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ onCallOrder: [2, 3], onCallCurrentTechnicianId: 2 }));
  });

  test('a cover the server refuses (it overlaps another) shows the server’s words in the dialog', async () => {
    api.createCover.mockRejectedValueOnce(Object.assign(new Error('Maria Lee already covers part of that time.'), { status: 409 }));
    const { reloadOnCall } = setup();
    fireEvent.click(within(weekRows()[1]).getByRole('button', { name: /^Set cover for Andrew Fong/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Who covers' }));
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set cover' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Maria Lee already covers part of that time.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(reloadOnCall).not.toHaveBeenCalled();
  });

  test('times follow the time zone sent with the settings', () => {
    setup({ timezone: 'America/Toronto' });
    expect(screen.getByTestId('on-call-now')).toHaveTextContent('until Mon 19 Oct, 20:00');
  });

  test('the next weeks: dates, person, cover lines, leave days and "Needs cover" as plain words', () => {
    setup();
    const rows = weekRows();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Mon 12 – Mon 19 Oct');
    expect(rows[0]).toHaveTextContent('This week');
    expect(rows[0]).toHaveTextContent('David Zapata');
    expect(rows[0]).not.toHaveTextContent('Needs cover');

    expect(rows[1]).toHaveTextContent('Andrew Fong');
    expect(rows[1]).toHaveTextContent('On leave Thu 22 Oct, Fri 23 Oct');
    expect(rows[1]).toHaveTextContent('Needs cover');
    // A dot and words, not a pill.
    expect(within(rows[1]).getByText('Needs cover').className).not.toMatch(/rounded-full|bg-/);

    // The week crosses the 1 Nov clock change; the cover runs to the handover.
    expect(rows[2]).toHaveTextContent('Mon 26 Oct – Mon 2 Nov');
    expect(rows[2]).toHaveTextContent('David Zapata covers Thu 29 Oct – Mon 2 Nov');

    expect(rows[3]).toHaveTextContent('Asked 4 people · 1 declined');
    expect(within(rows[3]).queryByRole('button', { name: /^Ask for cover/ })).not.toBeInTheDocument();
  });

  test('Set cover: the others in the rotation, the leave days to start with, and the payload', async () => {
    const { reloadOnCall } = setup();
    fireEvent.click(within(weekRows()[1]).getByRole('button', { name: /^Set cover for Andrew Fong/ }));
    const dialog = screen.getByRole('dialog', { name: 'Set cover for Andrew Fong' });
    // The leave days, midnight to midnight in the workspace time zone.
    expect(within(dialog).getByLabelText('From')).toHaveValue('2026-10-22T00:00');
    expect(within(dialog).getByLabelText('To')).toHaveValue('2026-10-24T00:00');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Set cover' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose who covers.');
    expect(api.createCover).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Who covers' }));
    // By default only the other people in the rotation.
    expect(optionLabels()).toEqual(['Choose a person', 'David Zapata', 'Maria Lee']);
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: 'Who covers' }), { key: 'Tab' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Show everyone/ }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Who covers' }));
    expect(optionLabels()).toEqual(['Choose a person', 'David Zapata', 'Maria Lee', 'Susan Xu']);
    fireEvent.click(screen.getByRole('option', { name: 'Maria Lee' }));
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: ' Swap ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set cover' }));

    await waitFor(() => expect(api.createCover).toHaveBeenCalledWith({
      originalTechnicianId: 2, coverTechnicianId: 3, startsAt: '2026-10-22T07:00:00.000Z', endsAt: '2026-10-24T07:00:00.000Z', note: 'Swap',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(reloadOnCall).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Cover set for Andrew Fong.');
  });

  test('Set cover on a week with no leave starts with the whole week (the rest of it, once under way)', () => {
    setup();
    fireEvent.click(within(weekRows()[2]).getByRole('button', { name: /^Set cover for Maria Lee/ }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('From')).toHaveValue('2026-10-26T17:00');
    expect(within(dialog).getByLabelText('To')).toHaveValue('2026-11-02T17:00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(within(weekRows()[0]).getByRole('button', { name: /^Set cover for David Zapata/ }));
    dialog = screen.getByRole('dialog');
    // Now is Wed 14 Oct 11:00 in Vancouver.
    expect(within(dialog).getByLabelText('From')).toHaveValue('2026-10-14T11:00');
    expect(within(dialog).getByLabelText('To')).toHaveValue('2026-10-19T17:00');
  });

  test('Ask for cover: everyone else in the order is asked unless unticked', async () => {
    const { reloadOnCall } = setup();
    fireEvent.click(within(weekRows()[1]).getByRole('button', { name: /^Ask for cover for Andrew Fong/ }));
    const dialog = screen.getByRole('dialog', { name: 'Ask for cover for Andrew Fong' });
    expect(dialog).toHaveTextContent('Cover is needed Thu 22 – Fri 23 Oct.');
    expect(within(dialog).getByRole('checkbox', { name: 'David Zapata' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Maria Lee' })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: 'Andrew Fong' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Maria Lee' }));
    fireEvent.change(within(dialog).getByLabelText(/^Message/), { target: { value: 'Can anyone take these two days?' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.createCoverRequest).toHaveBeenCalledWith({
      originalTechnicianId: 2, startsAt: '2026-10-22T07:00:00.000Z', endsAt: '2026-10-24T07:00:00.000Z', message: 'Can anyone take these two days?', askTechnicianIds: [1],
    }));
    await waitFor(() => expect(reloadOnCall).toHaveBeenCalled());
  });

  test('a request and a cover can be cancelled, each after an in-app confirm', async () => {
    const { reloadOnCall } = setup();
    fireEvent.click(within(weekRows()[3]).getByRole('button', { name: 'Cancel request' }));
    let confirm = screen.getByRole('alertdialog', { name: 'Cancel this request?' });
    expect(api.cancelCoverRequest).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(api.cancelCoverRequest).toHaveBeenCalledWith(11));
    await waitFor(() => expect(reloadOnCall).toHaveBeenCalledTimes(1));

    fireEvent.click(within(weekRows()[2]).getByRole('button', { name: 'Cancel cover' }));
    confirm = screen.getByRole('alertdialog', { name: 'Cancel this cover?' });
    expect(confirm).toHaveTextContent('Maria Lee is on call again for that time.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(api.cancelCover).not.toHaveBeenCalled();
    fireEvent.click(within(weekRows()[2]).getByRole('button', { name: 'Cancel cover' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel cover' }));
    await waitFor(() => expect(api.cancelCover).toHaveBeenCalledWith(7));
  });
});
