import { jest } from '@jest/globals';
import crypto from 'node:crypto';

/** Outbound webhooks v2: Standard-Webhooks signing, durable enqueue, worker. */

const prismaMock = {
  ticket: { findUnique: jest.fn().mockResolvedValue(null) },
  ticketTagLink: { findFirst: jest.fn().mockResolvedValue(null) },
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
    expect(WEBHOOK_EVENTS).toContain('ticket.fields_updated'); // Phase TU (TU-11)
    expect(WEBHOOK_EVENTS).toContain('ticket.note_added'); // Simorgh D2 (09-14)
    expect(WEBHOOK_EVENTS).toContain('ticket.ready_to_close'); // Simorgh B8 (09-19)
    for (const e of ['ticket.linked', 'ticket.parent_changed', 'ticket.merged', 'ticket.split', 'task.created', 'task.updated', 'task.completed']) expect(WEBHOOK_EVENTS).toContain(e); // Simorgh B-2
    expect(WEBHOOK_EVENTS).toHaveLength(19);
  });
});

describe('externalRefPrefix filter (ContinuIT D2)', () => {
  const PLAIN = { ...SUB, id: 1 };
  const MINE = { ...SUB, id: 2, externalRefPrefix: 'continuit:', events: ['ticket.created', 'ticket.parent_changed'] };

  test('a filtered subscription receives only tickets whose externalRef starts with its prefix; an unfiltered one gets everything', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([PLAIN, MINE]);
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 5, externalRef: 'simorgh:abc' } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.webhookDelivery.createMany.mock.calls[0][0].data.map((d) => d.subscriptionId)).toEqual([1]);

    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 6, externalRef: 'continuit:checkin:1' } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany.mock.calls[1][0].data.map((d) => d.subscriptionId)).toEqual([1, 2]);
  });

  test('a payload without externalRef consults the ticket row once; no match → not delivered to the filtered subscription', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([MINE]);
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ externalRef: 'continuit:x' });
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 7, subject: 'slim payload' } });
    await flush();
    expect(prismaMock.ticket.findUnique).toHaveBeenCalledWith({ where: { id: 7 }, select: { externalRef: true } });
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);

    prismaMock.ticket.findUnique.mockResolvedValueOnce({ externalRef: null });
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 8, subject: 'not mine' } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
  });

  test('relation payloads are matched on parent/child too', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([MINE]);
    dispatchWebhookEvent(1, 'ticket.parent_changed', { parent: { id: 1, externalRef: 'continuit:p' }, child: { id: 2, externalRef: null } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
  });
});

describe('matchTag filter (ContinuIT search, 23 Sep 2026)', () => {
  const TAGGED = { ...SUB, id: 3, externalRefPrefix: 'continuit:', matchTag: 'continuit', events: ['ticket.created', 'task.created'] };

  test('a linked ticket (someone else\'s externalRef) is delivered when its payload carries the tag', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([TAGGED]);
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 9, externalRef: null, tags: ['ContinuIT', 'vpn'] } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketTagLink.findFirst).not.toHaveBeenCalled();
  });

  test('a payload without the tag is confirmed on the row: tagged → delivered, untagged → not', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([TAGGED]);
    prismaMock.ticketTagLink.findFirst.mockResolvedValueOnce({ ticketId: 10 });
    dispatchWebhookEvent(1, 'task.created', { ticket: { id: 10, externalRef: '#241406' } });
    await flush();
    expect(prismaMock.ticketTagLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 10, tag: { name: { equals: 'continuit', mode: 'insensitive' } } } }));
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);

    prismaMock.ticketTagLink.findFirst.mockResolvedValueOnce(null);
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 11, externalRef: null, tags: [] } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
  });

  test('the prefix still wins on its own, without a tag lookup', async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([TAGGED]);
    dispatchWebhookEvent(1, 'ticket.created', { ticket: { id: 12, externalRef: 'continuit:task:1', tags: [] } });
    await flush();
    expect(prismaMock.webhookDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketTagLink.findFirst).not.toHaveBeenCalled();
  });
});
