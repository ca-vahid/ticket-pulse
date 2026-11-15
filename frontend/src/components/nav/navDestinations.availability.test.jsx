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

const { NAV_DESTINATIONS, destinationMatches, useNavDestinations } = await import('./navDestinations');

describe('Vacation Pulse nav entry (was Availability)', () => {
  test('label, hint, path and icon', () => {
    const dest = NAV_DESTINATIONS.find((d) => d.id === 'availability');
    // MEGA 11-14 Part J: people see "Vacation Pulse"; the id, path and icon keep the code name.
    expect(dest.label).toBe('Vacation Pulse');
    expect(dest.path).toBe('/availability');
    expect(dest.hint).toBe('Time away, WFH and site visits');
    expect(dest.Icon.displayName).toBe('AvailabilityNavIcon');
  });

  test('the /vacation-pulse alias counts as the same entry', () => {
    const dest = NAV_DESTINATIONS.find((d) => d.id === 'availability');
    expect(destinationMatches(dest, '/vacation-pulse')).toBe(true);
    expect(destinationMatches(dest, '/vacation-pulse/approvals')).toBe(true);
    expect(destinationMatches(dest, '/availability/my-time')).toBe(true);
    expect(destinationMatches(dest, '/vacation-pulsex')).toBe(false);
    expect(destinationMatches(NAV_DESTINATIONS.find((d) => d.id === 'tickets'), '/vacation-pulse')).toBe(false);
  });

  test('never abbreviated', () => {
    for (const d of NAV_DESTINATIONS) expect(`${d.label} ${d.hint || ''}`).not.toMatch(/\b(VP|VT)\b/);
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
