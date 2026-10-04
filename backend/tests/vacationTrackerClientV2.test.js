import { jest } from '@jest/globals';

// 4 Oct 2026: a VT API v2 key (vt_live_…) replaced the v1 key in settings.
// The client now follows the key: v2 = Bearer + /v2 paths, same data shapes
// (checked against prod: same leave/type/user ids, startHour/startMinute).

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { default: VacationTrackerClient, isV2Key } = await import('../src/integrations/vacationTracker.js');

test('isV2Key', () => {
  expect(isV2Key('vt_live_abc')).toBe(true);
  expect(isV2Key(' vt_test_x ')).toBe(true);
  expect(isV2Key('abcdef123')).toBe(false);
});

test('v1 key: x-api-key and /v1 paths, unchanged', async () => {
  const c = new VacationTrackerClient('legacy-key');
  expect(c.v2).toBe(false);
  expect(c.client.defaults.headers['x-api-key']).toBe('legacy-key');
  c.client.get = jest.fn().mockResolvedValue({ data: { data: [{ id: 'lt1' }] } });
  await c.fetchLeaveTypes();
  expect(c.client.get).toHaveBeenCalledWith('/v1/leave-types');
});

test('v2 key: Bearer, /v2 paths, every page, approved leave and active users only', async () => {
  const c = new VacationTrackerClient('vt_live_abc');
  expect(c.v2).toBe(true);
  expect(c.client.defaults.headers.Authorization).toBe('Bearer vt_live_abc');
  expect(c.client.defaults.headers['x-api-key']).toBeUndefined();
  c.client.get = jest.fn()
    .mockResolvedValueOnce({ data: { data: [{ id: 'L1', status: 'APPROVED' }, { id: 'L2', status: 'DENIED' }], nextToken: 't2' } })
    .mockResolvedValueOnce({ data: { data: [{ id: 'L3', status: 'APPROVED' }] } });
  const leaves = await c.fetchLeaves('2026-10-01', '2026-10-31');
  expect(leaves.map((l) => l.id)).toEqual(['L1', 'L3']);
  expect(c.client.get).toHaveBeenNthCalledWith(1, '/v2/leaves', { params: { startDate: '2026-10-01', endDate: '2026-10-31', limit: 100 } });
  expect(c.client.get).toHaveBeenNthCalledWith(2, '/v2/leaves', { params: { startDate: '2026-10-01', endDate: '2026-10-31', limit: 100, nextToken: 't2' } });

  c.client.get = jest.fn().mockResolvedValue({ data: { data: [{ id: 'u1', status: 'ACTIVE' }, { id: 'u2', status: 'INACTIVE' }] } });
  expect((await c.fetchUsers()).map((u) => u.id)).toEqual(['u1']);
  expect(c.client.get).toHaveBeenCalledWith('/v2/users', { params: { limit: 100 } });

  c.client.get = jest.fn().mockResolvedValue({ data: { data: [] } });
  expect(await c.testConnection()).toBe(true);
  expect(c.client.get).toHaveBeenCalledWith('/v2/users', { params: { limit: 1 } });
});
