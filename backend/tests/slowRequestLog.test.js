import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), http: jest.fn() };
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: logger }));

const { slowRequestLog, redactPath } = await import('../src/middleware/slowRequestLog.js');

function run({ elapsed, originalUrl = '/api/dashboard/technician/5/weekly?weekStart=2026-08-31&token=abc', route, baseUrl, contentType, status = 200 }) {
  let t = 1000;
  const mw = slowRequestLog({ thresholdMs: 1500, now: () => t });
  const req = { method: 'GET', originalUrl, url: originalUrl, route, baseUrl };
  const res = new EventEmitter();
  res.statusCode = status;
  res.getHeader = (name) => (name === 'content-type' ? contentType : undefined);
  const next = jest.fn();
  mw(req, res, next);
  expect(next).toHaveBeenCalled();
  t += elapsed;
  res.emit('finish');
}

beforeEach(() => logger.warn.mockClear());

test('logs a slow request with the route pattern, no query string', () => {
  run({ elapsed: 2400, route: { path: '/technician/:id/weekly' }, baseUrl: '/api/dashboard' });
  expect(logger.warn).toHaveBeenCalledWith('Slow request', {
    method: 'GET', path: '/api/dashboard/technician/:id/weekly', status: 200, ms: 2400,
  });
});

test('falls back to the URL path without the query when no route matched', () => {
  run({ elapsed: 1600, status: 404 });
  const [, meta] = logger.warn.mock.calls[0];
  expect(meta.path).toBe('/api/dashboard/technician/5/weekly');
  expect(JSON.stringify(meta)).not.toContain('token');
});

test('fast requests are silent', () => {
  run({ elapsed: 1500 });
  expect(logger.warn).not.toHaveBeenCalled();
});

test('SSE and other event streams are skipped', () => {
  run({ elapsed: 40_000, originalUrl: '/api/sse?workspaceId=1' });
  run({ elapsed: 40_000, originalUrl: '/api/sync/stream', contentType: 'text/event-stream; charset=utf-8' });
  expect(logger.warn).not.toHaveBeenCalled();
});

test('unmatched paths redact token-like segments (review N6)', () => {
  run({ elapsed: 2000, status: 404, originalUrl: '/ticket-status/eyJhbGciOiJIUzI1NiJ9abcDEF123?x=1' });
  expect(logger.warn.mock.calls[0][1].path).toBe('/ticket-status/:token');
  expect(redactPath('/api/public/approvals/3f2b8c1e-9a7d-4e21-b6c3-0d9e8f7a6b5c/view'))
    .toBe('/api/public/approvals/:token/view');
  expect(redactPath('/api/x/0123456789abcdef0123')).toBe('/api/x/:token');
  expect(redactPath('/api/x/a1B2c3D4e5F6g7H8')).toBe('/api/x/:token');
  // ordinary words and ids stay readable
  expect(redactPath('/api/dashboard/technician/5/weekly')).toBe('/api/dashboard/technician/5/weekly');
  expect(redactPath('/api/notification-workflows/templates')).toBe('/api/notification-workflows/templates');
});
