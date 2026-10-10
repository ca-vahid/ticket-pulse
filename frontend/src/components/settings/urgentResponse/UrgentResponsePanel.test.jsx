/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ON_CALL, PREVIEW, SETTINGS, SETTINGS_DATA, ok } from './urgentResponse.fixtures';

// The panel: four light tabs, the old #urgent-escalation link opening the
// fourth, and the mode control (Off / Shadow / Live) that saves at once and
// asks before going Live.

const api = vi.hoisted(() => ({}));
const settingsApi = vi.hoisted(() => ({}));
vi.mock('../../../services/api', () => ({
  get urgentResponseAPI() { return api; },
  get settingsAPI() { return settingsApi; },
}));
vi.mock('../../../hooks/useRequesterPhoto', () => ({ useRequesterPhoto: () => null }));
vi.mock('../../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT' } }) }));
const navStatus = vi.hoisted(() => ({ set: null }));
vi.mock('../../../hooks/useUrgentResponseStatus', () => ({ setUrgentResponseStatus: (...args) => navStatus.set(...args) }));

const { default: UrgentResponsePanel } = await import('./UrgentResponsePanel');
const { default: UrgentEscalationPanel } = await import('../UrgentEscalationPanel');

const POLICY = {
  automaticEnabled: false, selfServiceEnabled: true, afterHoursContactMode: 'weekly_rotation', afterHoursRotationOrder: [1, 2],
  baseRecipientIds: [1, 2], selfExtraRecipientIds: [], businessSupervisorRecipientIds: [], disabledChannels: [], dependencies: {},
};
const CANDIDATES = { candidates: [{ id: 1, name: 'David Zapata', channels: {} }, { id: 2, name: 'Andrew Fong', channels: {} }], providerStatus: {} };

const setup = (props = {}) => render(<MemoryRouter><UrgentResponsePanel previewDelayMs={0} {...props} /></MemoryRouter>);
const tab = (name) => screen.getByRole('tab', { name });
const modeRadio = (name) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  navStatus.set = vi.fn();
  Object.assign(api, {
    getSettings: vi.fn(async () => ok(SETTINGS_DATA)),
    getOnCall: vi.fn(async () => ok(ON_CALL)),
    updateSettings: vi.fn(async (patch) => ok({ settings: { ...SETTINGS, ...patch }, changes: [] })),
    getChanges: vi.fn(async () => ok([])),
    preview: vi.fn(async () => ok(PREVIEW)),
    getStats: vi.fn(async () => ok({ days: 30, live: {}, shadow: {} })),
    getActions: vi.fn(async () => ok({ items: [], nextBefore: null })),
  });
  Object.assign(settingsApi, {
    getUrgentEscalationPolicy: vi.fn(async () => ok(POLICY)),
    getUrgentEscalationCandidates: vi.fn(async () => ok(CANDIDATES)),
    updateUrgentEscalationPolicy: vi.fn(async () => ok(POLICY)),
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Urgent response panel', () => {
  test('four tabs; Rules opens first and the others load when opened', async () => {
    setup();
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['Rules', 'On-call', 'Log', 'Requester escalation']);
    expect(tab('Rules')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'The path of an urgent ticket' })).toBeInTheDocument();
    expect(api.getActions).not.toHaveBeenCalled();
    expect(settingsApi.getUrgentEscalationPolicy).not.toHaveBeenCalled();

    fireEvent.click(tab('On-call'));
    expect(await screen.findByTestId('on-call-now')).toHaveTextContent('David Zapata');
    expect(screen.getByRole('tabpanel', { name: 'On-call' })).toBeVisible();

    fireEvent.click(tab('Log'));
    await waitFor(() => expect(api.getActions).toHaveBeenCalled());
    expect(screen.getByRole('tabpanel', { name: 'Log' })).toBeVisible();
  });

  test('an unsaved Rules draft survives a look at another tab', async () => {
    setup();
    const notify = await screen.findByRole('spinbutton', { name: 'Minutes before the people at work are told' });
    fireEvent.change(notify, { target: { value: '12' } });
    fireEvent.click(tab('Log'));
    fireEvent.click(tab('Rules'));
    expect(screen.getByRole('spinbutton', { name: 'Minutes before the people at work are told' })).toHaveValue(12);
  });

  test('the old #urgent-escalation link opens the Requester escalation tab', async () => {
    setup({ initialTab: 'escalation' });
    expect(tab('Requester escalation')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(settingsApi.getUrgentEscalationPolicy).toHaveBeenCalled());
    // The new order is in use, so the old order list gives way to one sentence.
    const moved = await screen.findByTestId('rotation-order-moved');
    expect(moved).toHaveTextContent('The order, the handover time and any cover are set on the On-call tab.');
    expect(screen.queryByRole('button', { name: 'Up' })).not.toBeInTheDocument();
    fireEvent.click(within(moved).getByRole('button', { name: 'On-call tab' }));
    expect(tab('On-call')).toHaveAttribute('aria-selected', 'true');
  });

  test('the mode control shows the three modes with this feature’s hints', async () => {
    setup();
    await screen.findByRole('group', { name: 'Mode for this workspace' });
    expect(modeRadio('Shadow')).toBeChecked();
    expect(screen.getByText('Nothing happens.')).toBeInTheDocument();
    expect(screen.getByText('Every rule is worked out and recorded in the Log. No ticket moves and nobody is told.')).toBeInTheDocument();
    expect(screen.getByText('Tickets are redirected, moved and people are told.')).toBeInTheDocument();
  });

  test('going Live asks first; the mode is saved by itself', async () => {
    setup();
    await screen.findByRole('group', { name: 'Mode for this workspace' });
    fireEvent.click(modeRadio('Live'));
    const confirm = screen.getByRole('alertdialog', { name: 'Switch urgent response to Live?' });
    expect(api.updateSettings).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(modeRadio('Shadow')).toBeChecked();
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(modeRadio('Live'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Switch to Live' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ mode: 'live' }));
    await waitFor(() => expect(modeRadio('Live')).toBeChecked());
    expect(screen.getByText('Mode is now Live.')).toBeInTheDocument();
    // The On-call nav entry follows without a reload.
    expect(navStatus.set).toHaveBeenCalledWith(1, { mode: 'live', onCall: true });
  });

  test('every settings save tells the navigation the mode and whether an order is saved', async () => {
    api.getSettings.mockResolvedValueOnce(ok({ ...SETTINGS_DATA, settings: { ...SETTINGS, mode: 'off', onCallOrderSuggested: true }, onCallOrderSuggested: true }));
    setup();
    await screen.findByRole('group', { name: 'Mode for this workspace' });
    // A suggested order is not a saved one.
    fireEvent.click(modeRadio('Shadow'));
    await waitFor(() => expect(navStatus.set).toHaveBeenLastCalledWith(1, { mode: 'observe', onCall: false }));

    fireEvent.click(tab('On-call'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ onCallOrder: [1, 2, 3], onCallCurrentTechnicianId: 1 }));
    await waitFor(() => expect(navStatus.set).toHaveBeenLastCalledWith(1, { mode: 'observe', onCall: true }));

    fireEvent.click(tab('Rules'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minutes before the ticket moves' }), { target: { value: '45' } });
    fireEvent.click(within(screen.getByRole('tabpanel', { name: 'Rules' })).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenLastCalledWith({ clockMoveMinutes: 45 }));
    await waitFor(() => expect(navStatus.set).toHaveBeenCalledTimes(3));
  });

  test('times use the time zone sent with the settings, before the schedule’s', async () => {
    api.getSettings.mockResolvedValueOnce(ok({ ...SETTINGS_DATA, timezone: 'America/Toronto' }));
    api.getChanges.mockResolvedValue(ok([{ id: 1, changedByName: 'Vahid Haeri', field: 'mode', before: 'off', after: 'observe', createdAt: '2026-10-09T18:00:00Z' }]));
    setup();
    expect(await screen.findByTestId('urgent-changes')).toHaveTextContent('Oct 9, 2:00 PM');
  });

  test('Off and Shadow are saved without a confirm', async () => {
    setup();
    await screen.findByRole('group', { name: 'Mode for this workspace' });
    fireEvent.click(modeRadio('Off'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ mode: 'off' }));
    await waitFor(() => expect(modeRadio('Off')).toBeChecked());
  });

  test('a settings load that fails says so and can be retried', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('Admin access required'));
    setup();
    expect(await screen.findByText(/Admin access required/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'The path of an urgent ticket' })).toBeInTheDocument();
  });
});

describe('Requester escalation panel: rotation order', () => {
  test('keeps its own Up / Down list while the new order is not in use', async () => {
    render(<UrgentEscalationPanel />);
    expect(await screen.findAllByRole('button', { name: 'Up' })).toHaveLength(2);
    expect(screen.queryByTestId('rotation-order-moved')).not.toBeInTheDocument();
  });

  test('points to the On-call tab when the new order is in use', async () => {
    render(<UrgentEscalationPanel onCallOrderInUse />);
    expect(await screen.findByTestId('rotation-order-moved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Up' })).not.toBeInTheDocument();
    expect(screen.getByText('Rotation anchor date')).toBeInTheDocument();
  });
});
