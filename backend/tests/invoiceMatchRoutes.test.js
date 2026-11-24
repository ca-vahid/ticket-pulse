/**
 * Invoice match routes (24 Nov 2026): /api/mail-triage/invoice-match/...,
 * workspace admins only, against the real router and the real requireAdmin.
 * A role refusal is a 403, never a 401.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const invoiceMock = {
  MODES: ['off', 'shadow', 'live'],
  shadowReport: jest.fn(),
  getMode: jest.fn(),
  setMode: jest.fn(),
  settingsKey: (ws) => `invoice_match_ws${ws}`,
};
const wsRepo = { getAccessRole: jest.fn() };

jest.unstable_mockModule('../src/services/invoiceMatchService.js', () => ({ default: invoiceMock, ...invoiceMock }));
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({ default: wsRepo }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: router } = await import('../src/routes/invoiceMatch.routes.js');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user }; req.workspaceId = 2; next(); });
  app.use('/api/mail-triage', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  return app;
}
const ADMIN = { email: 'root@example.com', role: 'admin' };
const WS_ADMIN = { email: 'lead@example.com', role: 'user' };
const MEMBER = { email: 'ari@example.com', role: 'user' };

beforeEach(() => {
  jest.clearAllMocks();
  wsRepo.getAccessRole.mockImplementation(async (email) => (email === WS_ADMIN.email ? 'admin' : 'member'));
  invoiceMock.shadowReport.mockResolvedValue({ days: 7, summary: { total: 0 }, rows: [] });
  invoiceMock.getMode.mockResolvedValue('shadow');
  invoiceMock.setMode.mockImplementation(async (_ws, mode) => mode);
});

test('GET /invoice-match/shadow: admins and workspace admins read the report for their workspace; days passes through', async () => {
  const res = await request(buildApp(ADMIN)).get('/api/mail-triage/invoice-match/shadow?days=14');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: { days: 7, summary: { total: 0 }, rows: [] } });
  expect(invoiceMock.shadowReport).toHaveBeenCalledWith(2, { days: 14, limit: 500 });
  expect((await request(buildApp(WS_ADMIN)).get('/api/mail-triage/invoice-match/shadow')).status).toBe(200);
  expect(invoiceMock.shadowReport).toHaveBeenLastCalledWith(2, { days: 7, limit: 500 });
});

test('anyone else gets a 403 and nothing is read', async () => {
  expect((await request(buildApp(MEMBER)).get('/api/mail-triage/invoice-match/shadow')).status).toBe(403);
  expect((await request(buildApp(MEMBER)).put('/api/mail-triage/invoice-match/settings').send({ mode: 'live' })).status).toBe(403);
  expect(invoiceMock.shadowReport).not.toHaveBeenCalled();
  expect(invoiceMock.setMode).not.toHaveBeenCalled();
});

test('the switch: GET the mode, PUT off | shadow | live; anything else is a 400', async () => {
  const get = await request(buildApp(ADMIN)).get('/api/mail-triage/invoice-match/settings');
  expect(get.body.data).toEqual({ mode: 'shadow', key: 'invoice_match_ws2' });
  const put = await request(buildApp(WS_ADMIN)).put('/api/mail-triage/invoice-match/settings').send({ mode: 'Shadow' });
  expect(put.status).toBe(200);
  expect(invoiceMock.setMode).toHaveBeenCalledWith(2, 'shadow');
  expect((await request(buildApp(ADMIN)).put('/api/mail-triage/invoice-match/settings').send({ mode: 'on' })).status).toBe(400);
});
