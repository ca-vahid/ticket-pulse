import { jest } from '@jest/globals';
import crypto from 'node:crypto';

/** Outbound webhooks (gap plan 2 P3): signing, fan-out, failure accounting. */

const prismaMock = {
  webhookSubscription: {
    findMany: jest.fn(),
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

const {
  WEBHOOK_EVENTS, signWebhookPayload, dispatchWebhookEvent, testWebhookSubscription, invalidateWebhookCache,
} = await import('../src/services/webhookDispatchService.js');

const SUB = {
  id: 1, workspaceId: 1, url: 'https://example.com/hook', secret: 'whsec_test',
  events: ['ticket.created'], isEnabled: true, failureCount: 0, recentDeliveries: [],
};

const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  jest.clearAllMocks();
  invalidateWebhookCache(1);
  prismaMock.webhookSubscription.update.mockResolvedValue({});
});

describe('webhook dispatch', () => {
  test('signature is a stable HMAC-SHA256 over the raw body', () => {
    const body = '{"event":"ping"}';
    const expected = `sha256=${crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex')}`;
    expect(signWebhookPayload('whsec_test', body)).toBe(expected);
  });

  test('delivers a signed POST to matching subscriptions only', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      SUB,
      { ...SUB, id: 2, events: ['approval.decided'] }, // not subscribed to this event
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 5 } });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(options.headers['X-TicketPulse-Event']).toBe('ticket.created');
    expect(options.headers['X-TicketPulse-Signature']).toBe(signWebhookPayload('whsec_test', options.body));
    expect(JSON.parse(options.body).data.ticket.id).toBe(5);
  });

  test('unknown event types are ignored entirely', async () => {
    dispatchWebhookEvent(1, 'ticket.exploded', {});
    await flush();
    expect(prismaMock.webhookSubscription.findMany).not.toHaveBeenCalled();
  });

  test('a failed delivery increments failureCount and stores the error', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, failureCount: 3 });
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const result = await testWebhookSubscription(1, 1);
    expect(result.ok).toBe(false);
    const update = prismaMock.webhookSubscription.update.mock.calls[0][0];
    expect(update.data.failureCount).toBe(4);
    expect(update.data.lastError).toContain('500');
  });

  test('the 20th consecutive failure auto-disables the subscription', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, failureCount: 19 });
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await testWebhookSubscription(1, 1);
    const update = prismaMock.webhookSubscription.update.mock.calls[0][0];
    expect(update.data.failureCount).toBe(20);
    expect(update.data.isEnabled).toBe(false);
  });

  test('test-ping refuses unsafe URLs before any request', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ ...SUB, url: 'http://169.254.169.254/latest' });
    const result = await testWebhookSubscription(1, 1);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('event catalog matches the documented surface', () => {
    expect(WEBHOOK_EVENTS).toEqual([
      'ticket.created', 'ticket.status_changed', 'ticket.assigned', 'ticket.reply_received',
      'ticket.public_reply_added', 'ticket.tags_changed', 'approval.requested', 'approval.decided',
    ]);
  });
});
