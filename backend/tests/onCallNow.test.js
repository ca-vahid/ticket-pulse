import { jest } from '@jest/globals';

/** QA 10-27 #2: who is on call right now, cached a minute, never throws. */
const current = jest.fn();
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: { current } }));
const { isOnCallNow, _resetOnCallNowCache } = await import('../src/services/urgentResponse/onCallNow.js');

beforeEach(() => { current.mockReset(); _resetOnCallNowCache(); });

test('true only for the holder, false for everyone else', async () => {
  current.mockResolvedValue({ configured: true, technician: { id: 7 } });
  const now = new Date('2026-10-27T23:00:00Z');
  expect(await isOnCallNow(1, 7, now)).toBe(true);
  expect(await isOnCallNow(1, 8, now)).toBe(false);
  expect(current).toHaveBeenCalledTimes(1); // second answer came from the cache
});

test('the cache expires after a minute', async () => {
  current.mockResolvedValueOnce({ configured: true, technician: { id: 7 } }).mockResolvedValueOnce({ configured: true, technician: { id: 8 } });
  const t0 = new Date('2026-10-27T23:00:00Z');
  expect(await isOnCallNow(1, 7, t0)).toBe(true);
  expect(await isOnCallNow(1, 8, new Date(t0.getTime() + 61 * 1000))).toBe(true);
});

test('no saved rotation, bad ids or a failing read all answer false', async () => {
  current.mockResolvedValue({ configured: false, technician: null });
  expect(await isOnCallNow(1, 7)).toBe(false);
  expect(await isOnCallNow(null, 7)).toBe(false);
  _resetOnCallNowCache();
  current.mockRejectedValue(new Error('db down'));
  expect(await isOnCallNow(2, 7)).toBe(false);
});
