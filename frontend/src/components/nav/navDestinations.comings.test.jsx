/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({}) }));
import { NAV_DESTINATIONS } from './navDestinations';

// 2 Oct 2026 (Vahid): the HR lifecycle section covers both directions.
describe('Comings & Goings nav entry', () => {
  test('named for onboarding and offboarding, same route', () => {
    const dest = NAV_DESTINATIONS.find((d) => d.id === 'onboarding');
    expect(dest.label).toBe('Comings & Goings');
    expect(dest.hint).toBe('Onboarding & offboarding');
    expect(dest.path).toBe('/onboarding');
  });
});
