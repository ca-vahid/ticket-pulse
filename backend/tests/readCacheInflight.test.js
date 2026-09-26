import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

/**
 * QA 09-25: readCache coalesces concurrent identical GETs onto one handler
 * run, never shares or caches error bodies, and lets waiters recompute when
 * the leader dies without a JSON body.
 */

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() },
}));
jest.unstable_mockModule('../src/services/memoryDiagnostics.js', () => ({ registerGauge: jest.fn() }));

const { readCache, clearReadCache, getReadCacheStats } = await import('../src/services/dashboardReadCache.js');

function makeReq(path = '/technician/5/weekly', query = { weekStart: '2026-08-31' }) {
  return { method: 'GET', baseUrl: '/api/dashboard', path, query, workspaceId: 1, headers: {} };
}
function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.body = undefined;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; res.emit('finish'); return res; };
  return res;
}

beforeEach(() => clearReadCache());

test('concurrent identical requests share one handler run', async () => {
  const mw = readCache(10_000);
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  const before = getReadCacheStats().coalesced;
  const leaderRes = makeRes();
  mw(makeReq(), leaderRes, async () => {
    runs++;
    await gate;
    leaderRes.json({ success: true, n: runs });
  });

  const waiterRes = makeRes();
  const waiterNext = jest.fn();
  mw(makeReq(), waiterRes, waiterNext);

  expect(waiterNext).not.toHaveBeenCalled();
  release();
  await gate; await Promise.resolve(); await Promise.resolve();

  expect(runs).toBe(1);
  expect(leaderRes.body).toEqual({ success: true, n: 1 });
  expect(waiterRes.body).toEqual({ success: true, n: 1 });
  expect(waiterRes.statusCode).toBe(200);
  expect(getReadCacheStats().coalesced).toBe(before + 1);

  // Afterwards it's a plain cache hit.
  const hitRes = makeRes();
  const hitNext = jest.fn();
  mw(makeReq(), hitRes, hitNext);
  expect(hitNext).not.toHaveBeenCalled();
  expect(hitRes.body).toEqual({ success: true, n: 1 });
});

test('different query strings do not coalesce', () => {
  const mw = readCache(10_000);
  const a = jest.fn();
  const b = jest.fn();
  mw(makeReq('/x', { d: '1' }), makeRes(), a);
  mw(makeReq('/x', { d: '2' }), makeRes(), b);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
});

test('an error body is neither cached nor shared — waiters recompute', () => {
  const mw = readCache(10_000);
  const leaderRes = makeRes();
  mw(makeReq('/err'), leaderRes, () => {});
  const waiterNext = jest.fn();
  mw(makeReq('/err'), makeRes(), waiterNext);

  leaderRes.status(500).json({ success: false });
  expect(waiterNext).toHaveBeenCalledTimes(1);

  const againNext = jest.fn();
  mw(makeReq('/err'), makeRes(), againNext);
  expect(againNext).toHaveBeenCalledTimes(1); // not served from cache
});

test('leader closing without a body releases waiters', () => {
  const mw = readCache(10_000);
  const leaderRes = makeRes();
  mw(makeReq('/gone'), leaderRes, () => {});
  const waiterNext = jest.fn();
  mw(makeReq('/gone'), makeRes(), waiterNext);
  leaderRes.emit('close');
  expect(waiterNext).toHaveBeenCalledTimes(1);
});
