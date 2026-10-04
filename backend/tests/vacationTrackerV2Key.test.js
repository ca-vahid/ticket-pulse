import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// 3 Oct 2026: Vahid pasted a VT API v2 key (vt_live_…) into the v1 field; the
// v1 test failed and saving it would have stopped the hourly sync. The v2 key
// now has its own field + test, and the v1 field refuses v2 keys.

const vtRepo = { getConfig: jest.fn(), upsertConfig: jest.fn() };
const v2Test = jest.fn();
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: vtRepo }));
jest.unstable_mockModule('../src/services/vacationTrackerService.js', () => ({ default: { testConnection: jest.fn().mockResolvedValue({ success: true }) } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../src/integrations/vacationTrackerV2.js', () => ({
  default: class { testConnection() { return v2Test(); } },
  looksLikeV2Key: (k) => /^vt_(live|test)_/i.test(String(k || '').trim()),
  describeV2Error: (e) => `401 ${e.message}`,
}));

const { default: routes } = await import('../src/routes/vacationTracker.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const app = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.workspaceId = 1; next(); });
  a.use('/api/vacation-tracker', routes);
  a.use(errorHandler);
  return a;
};

beforeEach(() => {
  jest.clearAllMocks();
  vtRepo.upsertConfig.mockImplementation(async (_ws, data) => ({ syncEnabled: true, lastSyncAt: null, apiKey: 'v1key', apiKeyV2: data.apiKeyV2 ?? null }));
});

// 4 Oct 2026: the main field accepts a v2 key — the client follows the key
// (v2 serves the same ids and fields), so the hourly sync keeps running.
test('a v2 key in the main field is saved as the main key', async () => {
  const res = await request(app()).put('/api/vacation-tracker/config').send({ apiKey: 'vt_live_abc', syncEnabled: true });
  expect(res.status).toBe(200);
  expect(vtRepo.upsertConfig).toHaveBeenCalledWith(1, { apiKey: 'vt_live_abc', syncEnabled: true });
});

test('the main test runs for a v2 key too', async () => {
  const res = await request(app()).post('/api/vacation-tracker/config/test').send({ apiKey: 'vt_live_abc' });
  expect(res.body).toEqual({ success: true });
});

test('the v2 key saves to its own field and leaves the v1 key alone', async () => {
  const res = await request(app()).put('/api/vacation-tracker/config').send({ apiKeyV2: 'vt_live_abc' });
  expect(res.status).toBe(200);
  expect(vtRepo.upsertConfig).toHaveBeenCalledWith(1, { apiKeyV2: 'vt_live_abc' });
  expect(res.body.data).toMatchObject({ hasApiKey: true, hasApiKeyV2: true });
});

test('a non-v2 value in the v2 field is refused', async () => {
  const res = await request(app()).put('/api/vacation-tracker/config').send({ apiKeyV2: 'abc123' });
  expect(res.status).toBe(400);
});

test('v2 test: success and a readable failure', async () => {
  v2Test.mockResolvedValueOnce(true);
  expect((await request(app()).post('/api/vacation-tracker/config/test-v2').send({ apiKey: 'vt_live_abc' })).body).toEqual({ success: true });
  v2Test.mockRejectedValueOnce(new Error('Invalid API key'));
  const bad = await request(app()).post('/api/vacation-tracker/config/test-v2').send({ apiKey: 'vt_live_abc' });
  expect(bad.body).toEqual({ success: false, error: '401 Invalid API key' });
});
