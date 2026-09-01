import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * MB-2b — Graph change-notification endpoints. The handler must (1) echo the
 * validationToken as text/plain, (2) answer real notifications with 202
 * having done nothing but enqueue (no Graph, no DB in front of the response),
 * (3) optionally gate by IP.
 */

const subscriptionServiceMock = {
  enqueueNotifications: jest.fn(() => ({ queued: 1, duplicates: 0, invalid: 0, dropped: 0 })),
  handleLifecycleEvents: jest.fn(async () => []),
};
const graphMock = { getMessageForIngest: jest.fn(), isConfigured: jest.fn(() => true) };

jest.unstable_mockModule('../src/services/graphSubscriptionService.js', () => ({ default: subscriptionServiceMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock, graphErrorStatus: () => null }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: router, parseIpAllowlist, ipAllowed } = await import('../src/routes/graphNotifications.routes.js');

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '3mb' }));
  app.use('/api', router);
  return app;
}

const notification = {
  subscriptionId: 'sub-1',
  clientState: 'secret-1',
  changeType: 'created',
  resource: "Users('u1')/Messages('AAMk-msg-1')",
  resourceData: { '@odata.type': '#Microsoft.Graph.Message', id: 'AAMk-msg-1' },
  tenantId: 't1',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GRAPH_NOTIFICATION_IP_ALLOWLIST;
});

describe('validation handshake', () => {
  test.each(['/api/graph-notifications', '/api/graph-lifecycle'])('%s echoes validationToken as text/plain 200', async (path) => {
    const token = 'Validation: Testing client application reachability for subscription Request-Id: 1234 abc';
    const res = await request(makeApp()).post(path).query({ validationToken: token }).send();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe(token);
    expect(subscriptionServiceMock.enqueueNotifications).not.toHaveBeenCalled();
    expect(subscriptionServiceMock.handleLifecycleEvents).not.toHaveBeenCalled();
  });
});

describe('POST /api/graph-notifications', () => {
  test('enqueues and answers 202 without touching Graph', async () => {
    const res = await request(makeApp()).post('/api/graph-notifications').send({ value: [notification] });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, accepted: 1, duplicates: 0 });
    expect(subscriptionServiceMock.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(subscriptionServiceMock.enqueueNotifications).toHaveBeenCalledWith([notification]);
    expect(graphMock.getMessageForIngest).not.toHaveBeenCalled();
  });

  test('malformed body still 202s (Graph must never see a 4xx/5xx for retries)', async () => {
    subscriptionServiceMock.enqueueNotifications.mockReturnValueOnce({ queued: 0, duplicates: 0, invalid: 0, dropped: 0 });
    const res = await request(makeApp()).post('/api/graph-notifications').send({ nope: true });
    expect(res.status).toBe(202);
    expect(subscriptionServiceMock.enqueueNotifications).toHaveBeenCalledWith([]);
  });

  test('IP allowlist (when set) rejects other sources with 403 and never enqueues', async () => {
    process.env.GRAPH_NOTIFICATION_IP_ALLOWLIST = '52.159.,20.20.32.0';
    const denied = await request(makeApp()).post('/api/graph-notifications')
      .set('x-forwarded-for', '203.0.113.9').send({ value: [notification] });
    expect(denied.status).toBe(403);
    expect(subscriptionServiceMock.enqueueNotifications).not.toHaveBeenCalled();

    const allowed = await request(makeApp()).post('/api/graph-notifications')
      .set('x-forwarded-for', '52.159.10.10').send({ value: [notification] });
    expect(allowed.status).toBe(202);
    expect(subscriptionServiceMock.enqueueNotifications).toHaveBeenCalledTimes(1);
  });

  test('allowlist helpers: exact match, prefix match, IPv4-mapped IPv6', () => {
    const list = parseIpAllowlist(' 52.159., 20.20.32.5 ,,');
    expect(list).toEqual(['52.159.', '20.20.32.5']);
    expect(ipAllowed('52.159.1.2', list)).toBe(true);
    expect(ipAllowed('::ffff:20.20.32.5', list)).toBe(true);
    expect(ipAllowed('20.20.32.6', list)).toBe(false);
    expect(ipAllowed('anything', [])).toBe(true);
  });
});

describe('POST /api/graph-lifecycle', () => {
  test('202s immediately and hands the batch to the service asynchronously', async () => {
    const items = [{ subscriptionId: 'sub-1', clientState: 'secret-1', lifecycleEvent: 'reauthorizationRequired' }];
    const res = await request(makeApp()).post('/api/graph-lifecycle').send({ value: items });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, accepted: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriptionServiceMock.handleLifecycleEvents).toHaveBeenCalledWith(items);
  });

  test('empty batch does not invoke the handler', async () => {
    const res = await request(makeApp()).post('/api/graph-lifecycle').send({ value: [] });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscriptionServiceMock.handleLifecycleEvents).not.toHaveBeenCalled();
  });
});
