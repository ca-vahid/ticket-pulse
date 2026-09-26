import { jest } from '@jest/globals';

/**
 * QA 09-25 #2: requesters created by the history import (or FS sync) were never
 * looked up in Entra. The sweep looks up a batch of them on the tenant domains.
 */

const findMany = jest.fn();
const refresh = jest.fn();
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: { requester: { findMany } } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/requesterProfileService.js', () => ({ refreshRequesterEntraProfile: refresh }));

const { default: sweep, sweepDomains } = await import('../src/services/requesterEntraSweepService.js');
sweep.pauseMs = 0;

beforeEach(() => { findMany.mockReset(); refresh.mockReset(); sweep.attempted.clear(); });

test('looks up never-looked-up requesters on the tenant domains only', async () => {
  findMany.mockResolvedValue([{ id: 1, email: 'a@cambioearth.com' }, { id: 2, email: 'b@bgcengineering.ca' }]);
  refresh.mockResolvedValueOnce({ entraProfileSyncedAt: new Date() }).mockResolvedValueOnce({ entraMissingAt: new Date() });
  const out = await sweep.sweepOnce({ limit: 5 });
  expect(out).toEqual({ checked: 2, found: 1, missing: 1, failed: 0 });
  const where = findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ entraProfileSyncedAt: null, entraMissingAt: null });
  expect(where.OR.map((o) => o.email.endsWith)).toEqual(['@bgcengineering.ca', '@cambioearth.com']);
  expect(findMany.mock.calls[0][0].take).toBe(5);
});

test('a failed read degrades to an empty sweep', async () => {
  findMany.mockRejectedValue(new Error('column does not exist'));
  await expect(sweep.sweepOnce()).resolves.toEqual({ checked: 0, found: 0, missing: 0, failed: 0 });
  expect(refresh).not.toHaveBeenCalled();
});

test('domains come from REQUESTER_ENTRA_DOMAINS when set', () => {
  expect(sweepDomains({ REQUESTER_ENTRA_DOMAINS: ' X.com , y.org ' })).toEqual(['x.com', 'y.org']);
});

test('a failing row is counted, does not stop the batch, and is skipped for 24 h', async () => {
  findMany.mockResolvedValue([{ id: 7, email: 'bad@bgcengineering.ca' }, { id: 8, email: 'ok@bgcengineering.ca' }]);
  refresh.mockRejectedValueOnce(new Error('Graph 500')).mockResolvedValueOnce({ entraProfileSyncedAt: new Date() });
  const t0 = Date.parse('2026-09-25T10:00:00Z');
  const out = await sweep.sweepOnce({ now: t0 });
  expect(out).toEqual({ checked: 2, found: 1, missing: 0, failed: 1 });

  findMany.mockResolvedValue([]);
  await sweep.sweepOnce({ now: t0 + 30 * 60 * 1000 });
  expect(findMany.mock.calls[1][0].where.id).toEqual({ notIn: [7, 8] });

  await sweep.sweepOnce({ now: t0 + 24 * 60 * 60 * 1000 });
  expect(findMany.mock.calls[2][0].where.id).toBeUndefined();
});

test('start() runs one pass after 2 minutes, then every 30 min; timers are unref\'d', async () => {
  jest.useFakeTimers();
  const spy = jest.spyOn(sweep, 'sweepOnce').mockResolvedValue({});
  try {
    sweep.start();
    await jest.advanceTimersByTimeAsync(119 * 1000);
    expect(spy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * 1000);
    expect(spy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    sweep.stop();
    spy.mockRestore();
    jest.useRealTimers();
  }
});
