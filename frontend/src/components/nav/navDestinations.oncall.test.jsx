/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

// On-call (urgent response): one nav entry, last in the list, for every
// signed-in person (agents included) — but only in a workspace that uses it:
// the mode is not off, or an on-call order is set.

const authState = { user: { email: 'me@x.com', role: 'viewer' } };
const wsState = { currentWorkspace: { id: 1 }, availableWorkspaces: [{ id: 1, role: 'viewer' }] };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));
vi.mock('../../hooks/useHrLifecycleStatus', () => ({ useHrLifecycleStatus: () => ({ available: false, mode: 'off', loading: false }) }));
const getStatus = vi.fn();
vi.mock('../../services/api', () => ({ urgentResponseAPI: { getStatus: (...args) => getStatus(...args) } }));

const { NAV_DESTINATIONS, useNavDestinations } = await import('./navDestinations');
const { resetUrgentResponseStatus, setUrgentResponseStatus, useUrgentResponseStatus } = await import('../../hooks/useUrgentResponseStatus');

const ids = (result) => result.current.map((d) => d.id);
const as = (globalRole, wsRole) => {
  authState.user = { email: 'p@x.com', role: globalRole };
  wsState.availableWorkspaces = [{ id: 1, role: wsRole }];
};

afterEach(() => {
  cleanup();
  resetUrgentResponseStatus();
  getStatus.mockReset();
  authState.user = { email: 'me@x.com', role: 'viewer' };
  wsState.currentWorkspace = { id: 1 };
  wsState.availableWorkspaces = [{ id: 1, role: 'viewer' }];
});

describe('On-call nav entry', () => {
  test('label, hint, path and icon; last in the list', () => {
    const dest = NAV_DESTINATIONS[NAV_DESTINATIONS.length - 1];
    expect(dest).toMatchObject({ id: 'oncall', label: 'On-call', path: '/on-call', hint: 'Who covers after-hours urgent tickets', gate: 'onCall' });
    expect(dest.Icon.displayName).toBe('OnCallNavIcon');
  });

  test.each([
    ['agent', 'agent'],
    ['user', 'admin'],
    ['user', 'viewer'],
    ['user', 'reviewer'],
    ['user', 'readonly'],
  ])('shown to a %s user with workspace role %s when the mode is not off', async (globalRole, wsRole) => {
    as(globalRole, wsRole);
    getStatus.mockResolvedValue({ success: true, data: { mode: 'observe' } });
    const { result } = renderHook(() => useNavDestinations());
    expect(ids(result)).not.toContain('oncall'); // hidden until the server answers
    await waitFor(() => expect(ids(result)).toContain('oncall'));
    expect(ids(result)[ids(result).length - 1]).toBe('oncall');
  });

  test('mode off but an on-call order is set: still shown', async () => {
    as('agent', 'agent');
    getStatus.mockResolvedValue({ success: true, data: { mode: 'off', onCall: true } });
    const { result } = renderHook(() => useNavDestinations());
    await waitFor(() => expect(ids(result)).toEqual(['tickets', 'approvals', 'availability', 'oncall']));
  });

  test('mode off and no order: hidden for everyone', async () => {
    as('user', 'admin');
    getStatus.mockResolvedValue({ success: true, data: { mode: 'off', onCall: false } });
    const { result } = renderHook(() => useNavDestinations());
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(renderHook(() => useUrgentResponseStatus()).result.current.loading).toBe(false));
    expect(ids(result)).not.toContain('oncall');
  });

  test('fails closed: an error hides it', async () => {
    getStatus.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useNavDestinations());
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(renderHook(() => useUrgentResponseStatus()).result.current.loading).toBe(false));
    expect(ids(result)).not.toContain('oncall');
  });

  test('nobody signed in: no request, no entry', () => {
    authState.user = null;
    const { result } = renderHook(() => useNavDestinations());
    expect(ids(result)).not.toContain('oncall');
    expect(getStatus).not.toHaveBeenCalled();
  });

  test('one request per workspace, shared by every reader; a settings save updates them all', async () => {
    getStatus.mockResolvedValue({ success: true, data: { mode: 'off' } });
    const a = renderHook(() => useUrgentResponseStatus());
    const b = renderHook(() => useUrgentResponseStatus());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(a.result.current).toMatchObject({ mode: 'off', visible: false });

    setUrgentResponseStatus(1, { mode: 'live' });
    await waitFor(() => expect(a.result.current).toMatchObject({ mode: 'live', visible: true }));
    expect(b.result.current.visible).toBe(true);
  });
});
