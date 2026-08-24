/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Render-smoke test for the (2000-line) Tickets page. Its job is narrow but
// load-bearing: the page must MOUNT without throwing. Build + unit tests
// cannot catch declaration-order bugs (a useMemo dependency array reading a
// const declared later is a temporal-dead-zone ReferenceError only at render
// time) — exactly what blanked /tickets in prod on v3.0.79 ("Cannot access
// 'Vt' before initialization"). Chrome children are stubbed; the page's own
// hook/state wiring is what executes.
vi.mock('../services/api', () => ({
  // Any ticketsAPI method resolves to a forever-pending promise — the page can
  // call whatever it wants; we only care that mounting doesn't throw.
  ticketsAPI: new Proxy({}, { get: () => () => new Promise(() => {}) }),
  getGlobalExcludeNoise: vi.fn(() => false),
  setGlobalExcludeNoise: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'qa@example.com', role: 'admin' }, logout: vi.fn() }),
}));
vi.mock('../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspace: { id: 1, name: 'IT', slug: 'it' }, availableWorkspaces: [] }),
}));
const { roleRef } = vi.hoisted(() => ({ roleRef: { value: { role: 'admin', canManage: true, canReview: true } } }));
vi.mock('../components/nav/navDestinations', () => ({
  useWorkspaceRole: () => roleRef.value,
  NAV_DESTINATIONS: [],
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('../components/AppHeader', () => ({ default: () => <div>AppHeader</div> }));
vi.mock('../components/nav/MobileTabBar', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketPreview', () => ({ default: () => null }));
vi.mock('../components/tickets/ScheduledTicketsPanel', () => ({ default: () => null }));
vi.mock('../components/tickets/TicketFilterRail', () => ({
  default: () => null,
  ActiveFilterBar: () => null,
}));
vi.mock('../components/tickets/AiAssignModal', () => ({ default: () => null }));
vi.mock('../components/tickets/MobileAssignSheet', () => ({ default: () => null }));
vi.mock('../assets/tickets-hero.png', () => ({ default: 'hero.png' }));

import Tickets from './Tickets';

describe('Tickets page smoke', () => {
  afterEach(() => cleanup());

  test('mounts without throwing (guards declaration-order/TDZ regressions)', () => {
    render(<Tickets />, { wrapper: MemoryRouter });
    // Loading spinner state is fine — the assertion is that render didn't throw.
    expect(screen.getByText('AppHeader')).toBeInTheDocument();
  });

  test('mounts for a viewer-role member too (read/act split path, QA 08-19 #2)', () => {
    roleRef.value = 'viewer';
    render(<Tickets />, { wrapper: MemoryRouter });
    expect(screen.getByText('AppHeader')).toBeInTheDocument();
    roleRef.value = { role: 'admin', canManage: true, canReview: true };
  });
});
