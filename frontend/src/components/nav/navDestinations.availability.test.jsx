/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Availability (native Vacation Tracker replacement): one nav entry, open to
// every signed-in person — agents, observers and members included.

const authState = { user: { email: 'me@x.com', role: 'viewer' } };
const wsState = { currentWorkspace: { id: 1 }, availableWorkspaces: [{ id: 1, role: 'viewer' }] };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));
vi.mock('../../hooks/useHrLifecycleStatus', () => ({ useHrLifecycleStatus: () => ({ available: false, mode: 'off', loading: false }) }));

const { NAV_DESTINATIONS, useNavDestinations } = await import('./navDestinations');

describe('Availability nav entry', () => {
  test('label, hint, path and icon', () => {
    const dest = NAV_DESTINATIONS.find((d) => d.id === 'availability');
    expect(dest.label).toBe('Availability');
    expect(dest.path).toBe('/availability');
    expect(dest.hint).toBe('Time away, WFH and site visits');
    expect(dest.Icon.displayName).toBe('AvailabilityNavIcon');
  });

  test.each([
    ['agent', 'agent'],
    ['user', 'admin'],
    ['user', 'viewer'],
    ['user', 'reviewer'],
    ['user', 'readonly'],
  ])('visible to a %s user with workspace role %s', (globalRole, wsRole) => {
    authState.user = { email: 'p@x.com', role: globalRole };
    wsState.availableWorkspaces = [{ id: 1, role: wsRole }];
    const ids = renderHook(() => useNavDestinations()).result.current.map((d) => d.id);
    expect(ids).toContain('availability');
  });

  test('hidden when nobody is signed in', () => {
    authState.user = null;
    const ids = renderHook(() => useNavDestinations()).result.current.map((d) => d.id);
    expect(ids).not.toContain('availability');
  });
});
