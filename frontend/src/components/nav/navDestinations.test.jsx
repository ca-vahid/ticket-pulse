/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// v3.7.02 role lockdown (QA 08-24 #3): the pure role model behind every nav
// surface — fail-closed role resolution, the admin-only Settings gate, the
// role-aware home path, and the destination filter (no deep-link escape hatch).

const authState = { user: { email: 'me@x.com', role: 'viewer' } };
const wsState = { currentWorkspace: { id: 1 }, availableWorkspaces: [{ id: 1, role: 'viewer' }] };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => wsState }));

const {
  NAV_DESTINATIONS, canAccessSettings, homePathFor, isWorkspaceAdmin, resolveWorkspaceRole,
  useCanAccessSettings, useNavDestinations, useWorkspaceRole,
} = await import('./navDestinations');

const viewer = { email: 'v@x.com', role: 'viewer' };
const globalAdmin = { email: 'a@x.com', role: 'admin' };
const agent = { email: 't@x.com', role: 'agent' };

describe('resolveWorkspaceRole — fails CLOSED', () => {
  test('null when signed out, no workspace, or the workspace is not in the list', () => {
    expect(resolveWorkspaceRole(null, { id: 1 }, [{ id: 1, role: 'admin' }])).toBeNull();
    expect(resolveWorkspaceRole(viewer, null, [{ id: 1, role: 'admin' }])).toBeNull();
    expect(resolveWorkspaceRole(viewer, { id: 2 }, [{ id: 1, role: 'admin' }])).toBeNull();
    expect(resolveWorkspaceRole(viewer, { id: 1 }, [])).toBeNull();
    expect(resolveWorkspaceRole(viewer, { id: 1 }, undefined)).toBeNull();
  });

  test('the workspace access role when the workspace is resolved', () => {
    expect(resolveWorkspaceRole(viewer, { id: 1 }, [{ id: 1, role: 'reviewer' }])).toBe('reviewer');
    expect(resolveWorkspaceRole(viewer, { id: 1 }, [{ id: 1, role: 'admin' }])).toBe('admin');
    expect(resolveWorkspaceRole(agent, { id: 1 }, [{ id: 1, role: 'agent' }])).toBe('agent');
  });

  test('membership without a role label is the lowest tier (viewer), never admin', () => {
    expect(resolveWorkspaceRole(viewer, { id: 1 }, [{ id: 1 }])).toBe('viewer');
  });

  test('global admins are admin everywhere, even before hydration', () => {
    expect(resolveWorkspaceRole(globalAdmin, null, [])).toBe('admin');
  });
});

describe('isWorkspaceAdmin / canAccessSettings / homePathFor', () => {
  test('only workspace admins and global admins pass', () => {
    expect(isWorkspaceAdmin(viewer, 'viewer')).toBe(false);
    expect(isWorkspaceAdmin(viewer, 'reviewer')).toBe(false);
    expect(isWorkspaceAdmin(viewer, null)).toBe(false);
    expect(isWorkspaceAdmin(viewer, 'admin')).toBe(true);
    expect(isWorkspaceAdmin(globalAdmin, null)).toBe(true);
    expect(isWorkspaceAdmin(null, 'admin')).toBe(false);
  });

  test('Settings is admin-only; agents never, viewers/reviewers never', () => {
    expect(canAccessSettings(viewer, 'viewer')).toBe(false);
    expect(canAccessSettings(viewer, 'reviewer')).toBe(false);
    expect(canAccessSettings(agent, 'admin')).toBe(false);
    expect(canAccessSettings(viewer, 'admin')).toBe(true);
    expect(canAccessSettings(globalAdmin, null)).toBe(true);
    expect(canAccessSettings(null, 'admin')).toBe(false);
  });

  test('home: admins → /dashboard, everyone else (incl. unresolved) → /tickets', () => {
    expect(homePathFor(globalAdmin, null)).toBe('/dashboard');
    expect(homePathFor(viewer, 'admin')).toBe('/dashboard');
    expect(homePathFor(viewer, 'reviewer')).toBe('/tickets');
    expect(homePathFor(viewer, 'viewer')).toBe('/tickets');
    expect(homePathFor(viewer, null)).toBe('/tickets');
    expect(homePathFor(agent, 'agent')).toBe('/tickets');
    expect(homePathFor(null, null)).toBe('/tickets');
  });
});

describe('NAV_DESTINATIONS gates', () => {
  test('only Tickets and Approvals are ungated; every other tile is admin ("manage")', () => {
    const open = NAV_DESTINATIONS.filter((d) => d.gate === null).map((d) => d.id).sort();
    expect(open).toEqual(['approvals', 'tickets']);
    const gated = NAV_DESTINATIONS.filter((d) => d.gate !== null);
    expect(gated.every((d) => d.gate === 'manage')).toBe(true);
    expect(gated.map((d) => d.id).sort()).toEqual(['analytics', 'assignments', 'dashboard', 'map', 'timeline', 'workflows']);
  });
});

describe('hooks', () => {
  const ids = (result) => result.current.map((d) => d.id);

  test.each(['viewer', 'reviewer'])('useNavDestinations: %s → Tickets + Approvals only', (role) => {
    wsState.availableWorkspaces = [{ id: 1, role }];
    expect(ids(renderHook(() => useNavDestinations()).result)).toEqual(['tickets', 'approvals']);
    expect(renderHook(() => useCanAccessSettings()).result.current).toBe(false);
  });

  test('useNavDestinations: workspace admin → everything', () => {
    wsState.availableWorkspaces = [{ id: 1, role: 'admin' }];
    expect(ids(renderHook(() => useNavDestinations()).result)).toEqual(NAV_DESTINATIONS.map((d) => d.id));
    expect(renderHook(() => useCanAccessSettings()).result.current).toBe(true);
  });

  test('useWorkspaceRole fails closed to null before the workspace list is known', () => {
    wsState.availableWorkspaces = [];
    expect(renderHook(() => useWorkspaceRole()).result.current).toBeNull();
    expect(ids(renderHook(() => useNavDestinations()).result)).toEqual(['tickets', 'approvals']);
  });

  test('agents keep Tickets + Approvals regardless of workspace role label', () => {
    authState.user = agent;
    wsState.availableWorkspaces = [{ id: 1, role: 'agent' }];
    expect(ids(renderHook(() => useNavDestinations()).result)).toEqual(['tickets', 'approvals']);
    expect(renderHook(() => useCanAccessSettings()).result.current).toBe(false);
    authState.user = viewer;
  });
});
