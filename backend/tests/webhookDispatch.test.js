import { jest } from '@jest/globals';
import crypto from 'node:crypto';

/** Outbound webhooks v2: Standard-Webhooks signing, durable enqueue, worker. */

const prismaMock = {
  webhookSubscription: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  webhookDelivery: {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowActionNodes.js', () => ({
  webhookUrlProblem: (url) => (String(url).startsWith('https://') ? null : 'Webhook URL must be http(s)'),
}));

const fetchMock = jest.fn();
global.fetch = fetchMock;

const svc = await import('../src/services/webhookDispatchService.js');
const {
  WEBHOOK_EVENTS, signWebhookPayload, signStandardWebhook,
  dispatchWebhookEvent, testWebhookSubscription, processDue, invalidateWebhookCache,
} = svc;

const SUB = {
  id: 1, workspaceId: 1, url: 'https://example.com/hook', secret: 'whsec_dGVzdHNlY3JldA==',
  events: ['ticket.created'], isEnabled: true, failureCount: 0, recentDeliveries: [],
};

const flush = () => new Promise((r) => setTimeout(r, 40));

beforeEach(() => {
  jest.clearAllMocks();
  invalidateWebhookCache(1);
  prismaMock.webhookSubscription.update.mockResolvedValue({});
  prismaMock.webhookDelivery.createMany.mockResolvedValue({ count: 0 });
  prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
});

describe('webhook signing', () => {
  test('legacy signature is a stable HMAC-SHA256 over the raw body', () => {
    const body = '{"event":"ping"}';
    const expected = `sha256=${crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')}`;
    expect(signWebhookPayload('whsec_test', body)).toBe(expected);
  });

  test('standard-webhooks signature is v1,<base64 HMAC of id.timestamp.body> with decoded key', () => {
    const secret = 'whsec_dGVzdHNlY3JldA=='; // base64("testsecret")
    const key = Buffer.from('dGVzdHNlY3JldA==', 'base64');
    const sig = signStandardWebhook(secret, 'msg_1', 1700000000, '{}');
    const expected = `v1,${crypto.createHmac('sha256', key).update('msg_1.1700000000.{}').digest('base64')}`;
    expect(sig).toBe(expected);
  });
});

describe('durable enqueue', () => {
  test('enqueues one delivery per matching subscription only', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      SUB,
      { ...SUB, id: 2, events: ['approval.decided'] }, // not subscribed
    ]);
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 5 } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
    const rows = prismaMock.webhookDelivery.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriptionId).toBe(1);
    expect(rows[0].payload.data.ticket.id).toBe(5);
    expect(rows[0].eventId).toMatch(/^msg_/);
  });

  test('unknown event types are ignored entirely', async () => {
    dispatchWebhookEvent(1, 'ticket.exploded', {});
    await flush();
    expect(prismaMock.webhookSubscription.findMany).not.toHaveBeenCalled();
    expect(prismaMock.webhookDelivery.createMany).not.toHaveBeenCalled();
  });
});

describe('delivery worker', () => {
  const DELIVERY = { id: 9, subscriptionId: 1, eventId: 'msg_x', eventType: 'ticket.created', attempts: 0, maxAttempts: 8, payload: { type: 'ticket.created', data: {} } };

  test('a successful delivery marks success and sends both signatures', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([DELIVERY]);
    prismaMock.webhookSubscription.findUnique.mockResolvedValue(SUB);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await processDue();

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers['webhook-id']).toBe('msg_x');
    expect(options.headers['webhook-signature']).toMatch(/^v1,/);
    expect(options.headers['X-TicketPulse-Signature']).toMatch(/^sha256=/);
    const upd = prismaMock.webhookDelivery.update.mock.calls[0][0];
    expect(upd.data.status).toBe('success');
  });

  test('a failed delivery reschedules with backoff (still pending) until maxAttempts', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([{ ...DELIVERY, attempts: 1 }]);
    prismaMock.webhookSubscription.findUnique.mockResolvedValue(SUB);
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await processDue();
    const upd = prismaMock.webhookDelivery.update.mock.calls[0][0];
    expect(upd.data.status).toBe('pending');
    expect(upd.data.attempts).toBe(2);
    expect(upd.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('the final attempt dead-letters the delivery', async () => {
    prismaMock.webhookDelivery.findMany.mockResolvedValue([{ ...DELIVERY, attempts: 7, maxAttempts: 8 }]);
    prismaMock.webhookSubscription.findUnique.mockResolvedValue(SUB);
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    await processDue();
    const upd = prismaMock.webhookDelivery.update.mock.calls[0][0];
    expect(upd.data.status).toBe('dead');
  });
});

describe('test-ping + safety', () => {
  test('refuses unsafe URLs before any request', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, url: 'http://169.254.169.254/latest' });
    const result = await testWebhookSubscription(1, 1);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failed ping increments the subscription failureCount', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, failureCount: 3 });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const result = await testWebhookSubscription(1, 1);
    expect(result.ok).toBe(false);
    const upd = prismaMock.webhookSubscription.update.mock.calls[0][0];
    expect(upd.data.failureCount).toBe(4);
  });

  test('the 20th consecutive failure auto-disables the subscription', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, failureCount: 19 });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await testWebhookSubscription(1, 1);
    const upd = prismaMock.webhookSubscription.update.mock.calls[0][0];
    expect(upd.data.failureCount).toBe(20);
    expect(upd.data.isEnabled).toBe(false);
  });

  test('event catalogue is the documented set', () => {
    expect(WEBHOOK_EVENTS).toContain('ticket.created');
    expect(WEBHOOK_EVENTS).toContain('ticket.custom_fields_changed'); // Phase 2
    expect(WEBHOOK_EVENTS).toHaveLength(9);
  });
});
