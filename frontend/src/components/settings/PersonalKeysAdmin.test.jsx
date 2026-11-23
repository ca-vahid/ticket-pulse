/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Personal API keys, admin view (4.4.05): the API access picker (per person,
// like "Can see the Dashboard") and the table of everyone's personal keys.

const { keysApi, settingsApi } = vi.hoisted(() => ({
  keysApi: {
    list: vi.fn(),
    users: vi.fn(),
    setUsers: vi.fn(),
    setDisabled: vi.fn(),
    adminRevoke: vi.fn(),
  },
  settingsApi: { getTechnicians: vi.fn() },
}));
vi.mock('../../services/api', () => ({ personalApiKeysAPI: keysApi, settingsAPI: settingsApi }));

import PersonalKeysAdmin from './PersonalKeysAdmin';

const HOUR = 3600e3;
const ROSTER = [
  { id: 12, name: 'Dana Fox', email: 'dana.fox@example.com', isActive: true },
  { id: 13, name: 'Eli Park', email: 'eli.park@example.com', isActive: true },
  { id: 14, name: 'Priya Nair', email: 'priya.nair@example.com', isActive: true },
  { id: 15, name: 'Sam Okafor', email: 'sam.okafor@example.com', isActive: false },
];
const PEOPLE = [
  { technicianId: 12, name: 'Dana Fox', email: 'dana.fox@example.com', accessRole: null, isActive: true, onList: true, eligible: true, reason: null, hasKey: true },
  { technicianId: 13, name: 'Eli Park', email: 'eli.park@example.com', accessRole: 'viewer', isActive: true, onList: false, eligible: true, reason: null, hasKey: false },
  { technicianId: 14, name: 'Priya Nair', email: 'priya.nair@example.com', accessRole: null, isActive: true, onList: false, eligible: true, reason: null, hasKey: false },
  { technicianId: 15, name: 'Sam Okafor', email: 'sam.okafor@example.com', accessRole: null, isActive: false, onList: false, eligible: false, reason: 'Their agent profile is switched off.', hasKey: false },
  { technicianId: null, name: 'Observer Account', email: 'observer@example.com', accessRole: 'readonly', isActive: true, onList: false, eligible: false, reason: "No agent profile in this workspace, so they can't have a key.", hasKey: false },
];
const DANA_KEY = {
  id: 7,
  name: 'Reply assistant',
  prefix: 'tpu_ab12',
  abilities: ['read', 'reply', 'update'],
  createdAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
  expiresAt: new Date(Date.now() + 87 * 24 * HOUR).toISOString(),
  lastUsedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  lastUsedIp: '10.1.2.3',
  useCount: 40,
  ipAllowlist: [],
  status: 'active',
  owner: { name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12 },
};
const ELI_OLD = {
  ...DANA_KEY, id: 3, name: 'Old script', status: 'revoked', lastUsedAt: null, lastUsedIp: null,
  owner: { name: 'Eli Park', email: 'eli.park@example.com', technicianId: 13 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('no browser dialogs'); });
  settingsApi.getTechnicians.mockResolvedValue({ data: ROSTER });
  keysApi.list.mockResolvedValue({ success: true, data: { enabled: true, keys: [ELI_OLD, DANA_KEY] } });
  keysApi.users.mockResolvedValue({ success: true, data: { technicianIds: [12], people: PEOPLE } });
  keysApi.setUsers.mockImplementation(async (ids) => ({ success: true, data: { technicianIds: ids, revokedKeyIds: ids.includes(12) ? [] : [7] } }));
  keysApi.setDisabled.mockImplementation(async (id, disabled) => ({ success: true, data: { ...DANA_KEY, id, status: disabled ? 'disabled' : 'active' } }));
  keysApi.adminRevoke.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Personal API keys — API access picker', () => {
  test('a switch per active agent; on means on the list; nobody else', async () => {
    render(<PersonalKeysAdmin />);
    const picker = await screen.findByTestId('api-access-picker');
    expect(within(picker).getByRole('switch', { name: 'Dana Fox may have an API key' })).toHaveAttribute('aria-checked', 'true');
    expect(within(picker).getByRole('switch', { name: 'Eli Park may have an API key' })).toHaveAttribute('aria-checked', 'false');
    expect(within(picker).getByRole('switch', { name: 'Priya Nair may have an API key' })).toHaveAttribute('aria-checked', 'false');
    // People who can't have a key are tucked away, then shown unticked and locked with the reason.
    expect(within(picker).queryByRole('switch', { name: /Sam Okafor/ })).not.toBeInTheDocument();
    expect(picker).toHaveTextContent('Removing someone revokes their key.');
    expect(picker).toHaveTextContent('Has a key: “Reply assistant”');
    expect(picker).toHaveTextContent('1 of 3 people');
    expect(settingsApi.getTechnicians).not.toHaveBeenCalled();

    fireEvent.click(within(picker).getByRole('button', { name: "Show 2 people who can't have a key" }));
    const sam = within(picker).getByRole('switch', { name: 'Sam Okafor may have an API key' });
    expect(sam).toBeDisabled();
    expect(sam).toHaveAttribute('aria-checked', 'false');
    expect(picker).toHaveTextContent('Their agent profile is switched off.');
    expect(within(picker).getByRole('switch', { name: 'Observer Account may have an API key' })).toBeDisabled();
    expect(picker).toHaveTextContent("No agent profile in this workspace, so they can't have a key.");
  });

  test('an older backend without `people` falls back to the roster', async () => {
    keysApi.users.mockResolvedValue({ success: true, data: { technicianIds: [12] } });
    settingsApi.getTechnicians.mockResolvedValue({ data: ROSTER });
    render(<PersonalKeysAdmin />);
    const picker = await screen.findByTestId('api-access-picker');
    expect(within(picker).getByRole('switch', { name: 'Dana Fox may have an API key' })).toHaveAttribute('aria-checked', 'true');
    expect(within(picker).getByRole('switch', { name: 'Eli Park may have an API key' })).not.toBeDisabled();
    expect(within(picker).queryByRole('switch', { name: /Sam Okafor/ })).not.toBeInTheDocument();
  });

  test('a 422 names who cannot be added and why; nothing changes', async () => {
    keysApi.setUsers.mockRejectedValueOnce(Object.assign(new Error('Some people cannot have a key.'), {
      status: 422, code: 'personal_key_user_not_eligible', details: [{ technicianId: 14, reason: 'Their agent profile has no e-mail.' }],
    }));
    render(<PersonalKeysAdmin />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Priya Nair may have an API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some people cannot have a key. Priya Nair: Their agent profile has no e-mail.');
    expect(screen.getByRole('switch', { name: 'Priya Nair may have an API key' })).toHaveAttribute('aria-checked', 'false');
  });

  test('turning a person on saves the whole list, no confirmation needed', async () => {
    render(<PersonalKeysAdmin />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Eli Park may have an API key' }));
    await waitFor(() => expect(keysApi.setUsers).toHaveBeenCalledWith([12, 13]));
    expect(await screen.findByRole('status')).toHaveTextContent('Eli Park can now make a personal API key');
    expect(screen.getByRole('switch', { name: 'Eli Park may have an API key' })).toHaveAttribute('aria-checked', 'true');
  });

  test('removing someone with a key asks in the page and says the key is revoked', async () => {
    render(<PersonalKeysAdmin />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Dana Fox may have an API key' }));
    const ask = screen.getByRole('alertdialog', { name: 'Remove Dana Fox from API access?' });
    expect(ask).toHaveTextContent('Their key “Reply assistant” is revoked now and stops working.');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(keysApi.setUsers).not.toHaveBeenCalled();

    // Cancel keeps them on.
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(keysApi.setUsers).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Dana Fox may have an API key' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('switch', { name: 'Dana Fox may have an API key' }));
    keysApi.list.mockResolvedValue({ success: true, data: { enabled: true, keys: [ELI_OLD, { ...DANA_KEY, status: 'revoked' }] } });
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove and revoke the key' }));
    await waitFor(() => expect(keysApi.setUsers).toHaveBeenCalledWith([]));
    expect(await screen.findByRole('status')).toHaveTextContent('Dana Fox no longer has API access. Their key was revoked.');
    await waitFor(() => expect(keysApi.list).toHaveBeenCalledTimes(2));
    const row = screen.getAllByTestId('admin-key-row').find((r) => r.textContent.includes('Reply assistant'));
    expect(row).toHaveTextContent('Revoked');
  });

  test('a refused save rolls the switch back and shows why', async () => {
    keysApi.setUsers.mockRejectedValueOnce(Object.assign(new Error('Admin access required'), { status: 403 }));
    render(<PersonalKeysAdmin />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Priya Nair may have an API key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Admin access required');
    expect(screen.getByRole('switch', { name: 'Priya Nair may have an API key' })).toHaveAttribute('aria-checked', 'false');
  });

  test('a 403 on the reads hides the whole section', async () => {
    keysApi.list.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { container } = render(<PersonalKeysAdmin />);
    await waitFor(() => expect(keysApi.list).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("Personal API keys — everyone's keys", () => {
  test('owner, what it can do, status, created, expires, last used and where from; live keys first', async () => {
    render(<PersonalKeysAdmin />);
    const table = await screen.findByRole('table', { name: "Everyone's personal keys" });
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(
      ['Owner', 'What it can do', 'Status', 'Created', 'Expires', 'Last used', 'Actions'],
    );
    const rows = screen.getAllByTestId('admin-key-row');
    expect(rows[0]).toHaveTextContent('Dana Fox');
    expect(rows[0]).toHaveTextContent('“Reply assistant” · dana.fox@example.com');
    expect(rows[0]).toHaveTextContent('Read tickets · Reply and add notes · Update tickets');
    expect(rows[0]).toHaveTextContent('On');
    expect(rows[0]).toHaveTextContent('(in 87 days)');
    expect(rows[0]).toHaveTextContent('2 hours ago from 10.1.2.3');
    // The revoked one is listed after, with nothing to switch.
    expect(rows[1]).toHaveTextContent('Eli Park');
    expect(rows[1]).toHaveTextContent('Revoked');
    expect(rows[1]).toHaveTextContent('Not used yet');
    expect(within(rows[1]).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });

  test('switch a key off and back on', async () => {
    render(<PersonalKeysAdmin />);
    const sw = await screen.findByRole('switch', { name: 'Dana Fox\'s key “Reply assistant” is on' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(keysApi.setDisabled).toHaveBeenCalledWith(7, true));
    expect(await screen.findByRole('status')).toHaveTextContent('is switched off');
    const row = screen.getAllByTestId('admin-key-row')[0];
    expect(row).toHaveTextContent('Switched off');
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(keysApi.setDisabled).toHaveBeenCalledWith(7, false));
    await waitFor(() => expect(within(screen.getAllByTestId('admin-key-row')[0]).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  test('Revoke asks in the page first', async () => {
    render(<PersonalKeysAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Dana Fox\'s key “Reply assistant”' }));
    const ask = screen.getByRole('alertdialog', { name: "Revoke Dana Fox's key?" });
    expect(ask).toHaveTextContent('It stops working at once');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(keysApi.adminRevoke).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => expect(keysApi.adminRevoke).toHaveBeenCalledWith(7));
    expect(await screen.findByRole('status')).toHaveTextContent('is revoked');
  });

  test('no keys yet: one plain line', async () => {
    keysApi.list.mockResolvedValue({ success: true, data: { enabled: true, keys: [] } });
    render(<PersonalKeysAdmin />);
    expect(await screen.findByText('No one has made a personal key yet.')).toBeInTheDocument();
  });
});
