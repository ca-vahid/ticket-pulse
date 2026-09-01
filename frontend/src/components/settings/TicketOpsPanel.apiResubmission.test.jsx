/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiResubmissionSection } from './TicketOpsPanel';
import { settingsAPI } from '../../services/api';

// Mega 08-31 Phase PA (QA #4) — Settings → Ticket Ops → "API resubmissions":
// the workspace custom-field bridge key picker (zero-Power-Apps-change path)
// and the deprecated requester+subject heuristic toggle + window.

const FIELDS = [
  { id: 1, key: 'client_name', label: 'Client Name', type: 'text', isActive: true },
  { id: 2, key: 'power_app_record_id', label: 'Power App Record Id', type: 'text', isActive: true },
];
const CFG = { apiResubmissionMatchEnabled: false, apiResubmissionMatchWindowDays: 7, externalRefCustomFieldKey: null };

vi.mock('../../services/api', () => ({
  settingsAPI: {
    getApiResubmission: vi.fn(() => Promise.resolve({ data: { data: { ...CFG } } })),
    updateApiResubmission: vi.fn((patch) => Promise.resolve({ data: { data: { ...CFG, ...patch } } })),
    getCustomFields: vi.fn(() => Promise.resolve({ data: { data: FIELDS } })),
  },
  ticketsAPI: {},
  workspaceAPI: {},
}));
vi.mock('../../hooks/useTicketTypes', () => ({
  useTicketTypes: () => ({ types: [], activeTypes: [], defaultType: null, refresh: vi.fn() }),
  invalidateTicketTypesCache: vi.fn(),
}));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ currentWorkspace: { id: 5 } }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderLoaded(cfg = {}) {
  settingsAPI.getApiResubmission.mockResolvedValueOnce({ data: { data: { ...CFG, ...cfg } } });
  render(<ApiResubmissionSection />);
  await waitFor(() => expect(screen.getByLabelText('Match on a custom field')).toBeInTheDocument());
}

describe('ApiResubmissionSection', () => {
  test('renders the card copy, the field picker with the workspace definitions, and the deprecated toggle off', async () => {
    await renderLoaded();
    expect(screen.getByText('API resubmissions (Power Apps / integrations)')).toBeInTheDocument();
    expect(screen.getByText(/Treat a resubmitted Power Apps \/ API request as an update to the existing ticket/)).toBeInTheDocument();
    const picker = screen.getByLabelText('Match on a custom field');
    expect(picker).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Off — match on externalRef only' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Power App Record Id (power_app_record_id)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Client Name (client_name)' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Requester and subject matching off/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Transition only')).toBeInTheDocument();
    // Window input is disabled while the heuristic is off.
    expect(screen.getByLabelText('Window')).toBeDisabled();
  });

  test('picking a custom field PUTs externalRefCustomFieldKey and shows the pa- namespace hint', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Match on a custom field'), { target: { value: 'power_app_record_id' } });
    await waitFor(() => expect(settingsAPI.updateApiResubmission).toHaveBeenCalledWith({ externalRefCustomFieldKey: 'power_app_record_id' }));
    await waitFor(() => expect(screen.getByLabelText('Match on a custom field')).toHaveValue('power_app_record_id'));
    expect(screen.getByText(/refs stored as pa-/)).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  test('picking "Off" clears the key (null)', async () => {
    await renderLoaded({ externalRefCustomFieldKey: 'power_app_record_id' });
    expect(screen.getByLabelText('Match on a custom field')).toHaveValue('power_app_record_id');
    fireEvent.change(screen.getByLabelText('Match on a custom field'), { target: { value: '' } });
    await waitFor(() => expect(settingsAPI.updateApiResubmission).toHaveBeenCalledWith({ externalRefCustomFieldKey: null }));
  });

  test('flipping the heuristic switch PUTs the flag, enables the window, and the window commits on blur (1–90 only)', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('switch', { name: /Requester and subject matching/ }));
    await waitFor(() => expect(settingsAPI.updateApiResubmission).toHaveBeenCalledWith({ apiResubmissionMatchEnabled: true }));
    await waitFor(() => expect(screen.getByRole('switch', { name: /Requester and subject matching on/ })).toHaveAttribute('aria-checked', 'true'));
    const windowInput = screen.getByLabelText('Window');
    expect(windowInput).toBeEnabled();

    fireEvent.change(windowInput, { target: { value: '30' } });
    fireEvent.blur(windowInput);
    await waitFor(() => expect(settingsAPI.updateApiResubmission).toHaveBeenCalledWith({ apiResubmissionMatchWindowDays: 30 }));

    // Out-of-range input snaps back and is NOT sent.
    settingsAPI.updateApiResubmission.mockClear();
    fireEvent.change(windowInput, { target: { value: '400' } });
    fireEvent.blur(windowInput);
    await waitFor(() => expect(windowInput).toHaveValue(30));
    expect(settingsAPI.updateApiResubmission).not.toHaveBeenCalled();
  });

  test('a rejected save surfaces the server message', async () => {
    await renderLoaded();
    settingsAPI.updateApiResubmission.mockRejectedValueOnce({ response: { data: { message: 'Unknown custom field "nope"' } } });
    fireEvent.change(screen.getByLabelText('Match on a custom field'), { target: { value: 'client_name' } });
    await waitFor(() => expect(screen.getByText(/Unknown custom field "nope"/)).toBeInTheDocument());
  });
});
