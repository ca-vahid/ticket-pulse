import { reconcileShouldYield, reconcileSlot, resetReconcilePace } from '../src/utils/fsBackgroundPace.js';

// 6 Oct 2026: one pace for every background FreshService read.
describe('fsBackgroundPace', () => {
  beforeEach(() => resetReconcilePace());

  test('callers share one slot: the second and third wait one gap each, whoever they are', async () => {
    const waits = [];
    const sleep = async (ms) => { waits.push(Math.round(ms / 100) * 100); };
    await reconcileSlot(sleep, 1000);
    await reconcileSlot(sleep, 1000);
    await reconcileSlot(sleep, 1000);
    expect(waits).toEqual([1000, 2000]);
  });

  test('yields on a slowdown, a waiting person, or 60% of the cap; never without stats', () => {
    expect(reconcileShouldYield(null)).toBe(false);
    expect(reconcileShouldYield({ slowdownActive: true })).toBe(true);
    expect(reconcileShouldYield({ queueDepthByPriority: { high: 1 } })).toBe(true);
    expect(reconcileShouldYield({ maxRequestsPerMinute: 200, requestsLastMinute: 120 })).toBe(true);
    expect(reconcileShouldYield({ maxRequestsPerMinute: 200, requestsLastMinute: 80, queueDepthByPriority: { high: 0, low: 9 } })).toBe(false);
  });
});
