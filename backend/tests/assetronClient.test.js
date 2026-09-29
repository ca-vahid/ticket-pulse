import { jest } from '@jest/globals';

/** The Assetron external API contract (Sam's guide, 24 Sep 2026) as our client speaks it. */
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { default: client, AssetronError, isConfigured } = await import('../src/integrations/assetronClient.js');

const getToken = jest.fn(async () => ({ token: 'tok-1', expiresOnTimestamp: Date.now() + 3600e3 }));
const calls = [];
const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  calls.length = 0;
  getToken.mockClear();
  process.env.ASSETRON_API_BASE_URL = 'https://assetron.example/api/v1/';
  process.env.ASSETRON_API_SCOPE = 'api://assetron-client/.default';
  client._setCredential({ getToken });
});
afterAll(() => client._reset());

test('not configured without a base URL and a way to sign in', () => {
  delete process.env.ASSETRON_API_SCOPE;
  expect(isConfigured()).toBe(false);
  process.env.ASSETRON_API_KEY = 'k-1';
  expect(isConfigured()).toBe(true);
  delete process.env.ASSETRON_API_BASE_URL;
  expect(isConfigured()).toBe(false);
  delete process.env.ASSETRON_API_KEY;
});

test('API key: sent in x-api-key by default, no Entra token requested; wins over a scope', async () => {
  process.env.ASSETRON_API_KEY = 'k-1';
  client._setFetch(async (url, init) => { calls.push({ url, init }); return respond(200, { data: {} }); });
  await client.filterOptions();
  expect(getToken).not.toHaveBeenCalled();
  expect(calls[0].init.headers['x-api-key']).toBe('k-1');
  expect(calls[0].init.headers.authorization).toBeUndefined();
  process.env.ASSETRON_API_KEY_HEADER = 'Authorization';
  await client.filterOptions();
  expect(calls[1].init.headers.authorization).toBe('Bearer k-1');
  delete process.env.ASSETRON_API_KEY;
  delete process.env.ASSETRON_API_KEY_HEADER;
});

test('token for the configured scope, Bearer on the call, cached between calls', async () => {
  client._setFetch(async (url, init) => { calls.push({ url, init }); return respond(200, { data: { make: ['Dell'] } }); });
  await client.filterOptions();
  await client.filterOptions();
  expect(getToken).toHaveBeenCalledTimes(1);
  expect(getToken).toHaveBeenCalledWith('api://assetron-client/.default');
  expect(calls[0].url).toBe('https://assetron.example/api/v1/assets/filter-options');
  expect(calls[0].init.headers.authorization).toBe('Bearer tok-1');
});

test('search: comma = OR within a key, status forced to NEW whatever the caller sends', async () => {
  client._setFetch(async (url) => { calls.push({ url }); return respond(200, { data: [{ id: 'a' }], pagination: { totalItems: 1 } }); });
  const r = await client.searchAssets({ ram: ['16 GB', '32 GB'], location: 'Vancouver', status: ['AVAILABLE'], touchScreen: [true] }, { pageSize: 500 });
  const q = new URL(calls[0].url).searchParams;
  expect(q.get('ram')).toBe('16 GB,32 GB');
  expect(q.get('location')).toBe('Vancouver');
  expect(q.get('touchScreen')).toBe('true');
  expect(q.get('status')).toBe('NEW');
  expect(q.get('pageSize')).toBe('100');
  expect(r.items).toEqual([{ id: 'a' }]);
});

test('listAllNew walks every page of NEW devices (100 a page) and stops at the cap', async () => {
  const pages = { 1: 100, 2: 100, 3: 37 };
  client._setFetch(async (url) => {
    const q = new URL(url).searchParams;
    calls.push(q.get('page'));
    const n = pages[q.get('page')] || 0;
    return respond(200, { data: Array.from({ length: n }, (_, i) => ({ id: `${q.get('page')}-${i}` })), pagination: { page: Number(q.get('page')), pageSize: 100, totalItems: 237, totalPages: 3 } });
  });
  const all = await client.listAllNew();
  expect(calls).toEqual(['1', '2', '3']);
  expect(all).toMatchObject({ total: 237, truncated: false });
  expect(all.items).toHaveLength(237);
  calls.length = 0;
  const capped = await client.listAllNew({ maxItems: 150 });
  expect(capped.items).toHaveLength(150);
  expect(capped.truncated).toBe(true);
  expect(calls).toEqual(['1', '2']);
});

test('error envelope → AssetronError with the agent-safe message and the machine reason', async () => {
  client._setFetch(async () => respond(409, { error: { code: 'CONFLICT', message: 'This laptop is On Hold for TP-1650.', details: [{ field: 'assetId', message: 'ASSET_UNAVAILABLE' }] } }));
  const err = await client.createReservation({ assetId: 'x' }).catch((e) => e);
  expect(err).toBeInstanceOf(AssetronError);
  expect(err).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'ASSET_UNAVAILABLE', field: 'assetId', message: 'This laptop is On Hold for TP-1650.' });
  expect(err.retryable).toBe(false);
});

test('5xx is retried; 200 after a retry is a success', async () => {
  let n = 0;
  client._setFetch(async () => { n += 1; return n === 1 ? respond(503, {}) : respond(200, { data: { reservationId: 'r1', status: 'APPROVED' } }); });
  const data = await client.decideReservation('r1', { status: 'APPROVED' });
  expect(n).toBe(2);
  expect(data.reservationId).toBe('r1');
});

test('401 drops the cached token so the next call fetches a fresh one', async () => {
  client._setFetch(async () => respond(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } }));
  await expect(client.getAsset('x')).rejects.toMatchObject({ status: 401 });
  client._setFetch(async () => respond(200, { data: { id: 'x' } }));
  await client.getAsset('x');
  expect(getToken).toHaveBeenCalledTimes(2);
});
