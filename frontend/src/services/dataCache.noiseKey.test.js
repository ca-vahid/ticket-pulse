/** @vitest-environment jsdom */
import { describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ excludeNoise: false }));
vi.mock('./api', () => ({
  getWorkspaceId: () => 3,
  getGlobalExcludeNoise: () => state.excludeNoise,
}));

import { cacheKeys } from './dataCache';

// N4: the technician page's cached getters must not serve the other
// noise setting's numbers.
describe('technician cache keys carry the noise toggle', () => {
  test('daily + weekly keys differ by the exclude-noise setting', () => {
    state.excludeNoise = false;
    const dailyAll = cacheKeys.techDaily(7, 'America/Los_Angeles', '2026-09-25');
    const weeklyAll = cacheKeys.techWeekly(7, 'America/Los_Angeles', '2026-09-21');
    state.excludeNoise = true;
    const dailyClean = cacheKeys.techDaily(7, 'America/Los_Angeles', '2026-09-25');
    const weeklyClean = cacheKeys.techWeekly(7, 'America/Los_Angeles', '2026-09-21');
    expect(dailyClean).not.toBe(dailyAll);
    expect(weeklyClean).not.toBe(weeklyAll);
    // The date / week markers the SSE invalidation predicates match stay intact.
    expect(dailyClean).toContain('date=2026-09-25');
    expect(weeklyClean).toContain('weekStart=2026-09-21');
    expect(dailyAll).toBe('ws3:tech:daily:id=7:tz=America/Los_Angeles:date=2026-09-25');
  });
});
