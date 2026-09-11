import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * FR 09-11 — "I assigned the tickets in TP but it didn't sync to FreshService."
 *
 * It did sync, ~15-20 minutes later. Measured over 7 days the mirror had a
 * 5-minute median and a 45-minute p95, and TP-1286's job sat `pending` for ten
 * minutes without a single attempt while TP-1285's job — a DIFFERENT ticket —
 * waited on the FreshService API.
 *
 * Two causes, both fixed here:
 *   1. drain() was one sequential loop behind a global lock, so one slow call
 *      blocked every other ticket.
 *   2. The background mirror client had no queue timeout, so that slow call
 *      could wait behind an entire sync sweep for ever.
 *
 * The ordering guarantee must survive both: jobs for ONE ticket still run in
 * id order and still stop at the first failure.
 */

const findMany = jest.fn();
const update = jest.fn().mockResolvedValue({});
const count = jest.fn().mockResolvedValue(0);
const updateMany = jest.fn().mockResolvedValue({ count: 1 });
const findFirst = jest.fn().mockResolvedValue(null);

const ticketUpdate = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    mirrorJob: { findMany, update, count, updateMany, findFirst },
    ticket: { update: ticketUpdate },
  },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: mirrorService, isQueueTimeout } = await import('../src/services/mirrorService.js');

const job = (id, ticketId, kind = 'update_fields') => ({
  id, ticketId, kind, workspaceId: 1, attempts: 0, updatedAt: new Date(),
});

beforeEach(() => {
  findMany.mockReset();
  update.mockClear();
  ticketUpdate.mockClear();
  process.env.NATIVE_TICKET_MIRROR_ENABLED = 'true';
});

describe('one slow ticket no longer blocks the others', () => {
  test('jobs for different tickets overlap instead of queueing behind each other', async () => {
    findMany.mockResolvedValue([job(1, 101), job(2, 202), job(3, 303), job(4, 404)]);

    const started = [];
    let running = 0;
    let peak = 0;
    mirrorService._processJob = async (j) => {
      started.push(j.ticketId);
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running -= 1;
      return true;
    };

    const res = await mirrorService.drain();
    expect(res.processed).toBe(4);
    expect(res.tickets).toBe(4);
    // The whole point: more than one ticket in flight at a time.
    expect(peak).toBeGreaterThan(1);
  });

  test('a ticket that hangs does not stop the rest finishing', async () => {
    findMany.mockResolvedValue([job(1, 101), job(2, 202), job(3, 303)]);
    const done = [];
    mirrorService._processJob = async (j) => {
      if (j.ticketId === 101) await new Promise((r) => setTimeout(r, 120)); // the slow one
      done.push(j.ticketId);
      return true;
    };
    await mirrorService.drain();
    // 202 and 303 completed before the slow 101.
    expect(done.indexOf(202)).toBeLessThan(done.indexOf(101));
    expect(done.indexOf(303)).toBeLessThan(done.indexOf(101));
  });
});

describe('per-ticket ordering is unchanged', () => {
  test('one ticket\'s jobs run in id order, never in parallel', async () => {
    findMany.mockResolvedValue([job(1, 101, 'create_ticket'), job(2, 101), job(3, 101)]);
    const order = [];
    let concurrentWithinTicket = 0;
    let inTicket = 0;
    mirrorService._processJob = async (j) => {
      inTicket += 1; concurrentWithinTicket = Math.max(concurrentWithinTicket, inTicket);
      order.push(j.id);
      await new Promise((r) => setTimeout(r, 10));
      inTicket -= 1;
      return true;
    };
    await mirrorService.drain();
    expect(order).toEqual([1, 2, 3]);
    expect(concurrentWithinTicket).toBe(1);
  });

  test('a failure stops that ticket but not the others', async () => {
    findMany.mockResolvedValue([job(1, 101), job(2, 101), job(3, 202)]);
    const ran = [];
    mirrorService._processJob = async (j) => {
      ran.push(j.id);
      return j.id !== 1; // ticket 101's first job fails
    };
    await mirrorService.drain();
    expect(ran).toContain(1);
    expect(ran).not.toContain(2);   // blocked behind its own failed predecessor
    expect(ran).toContain(3);       // a different ticket is unaffected
  });
});

describe('a busy FreshService queue defers instead of failing', () => {
  test('isQueueTimeout recognises the back-pressure error', () => {
    expect(isQueueTimeout({ code: 'FS_QUEUE_TIMEOUT' })).toBe(true);
    expect(isQueueTimeout(new Error('FS_QUEUE_TIMEOUT: waited too long'))).toBe(true);
    expect(isQueueTimeout(new Error('404 not found'))).toBe(false);
    expect(isQueueTimeout(null)).toBe(false);
  });

  test('a queue timeout re-queues without burning an attempt', async () => {
    await mirrorService._markFailed(job(9, 101), 'FS_QUEUE_TIMEOUT', { softRetry: true });
    const data = update.mock.calls.at(-1)[0].data;
    expect(data.status).toBe('pending');
    expect(data.attempts).toBeUndefined();      // attempt NOT consumed
    expect(data.nextAttemptAt.getTime()).toBeLessThan(Date.now() + 60_000); // retried promptly
    // A deferral is not an error: the ticket must not be flagged as failed.
    expect(ticketUpdate).not.toHaveBeenCalled();
  });

  test('a real failure still counts an attempt and backs off', async () => {
    await mirrorService._markFailed(job(9, 101), 'FreshService 500');
    const data = update.mock.calls.at(-1)[0].data;
    expect(data.attempts).toBe(1);
    expect(data.status).toBe('failed');
  });
});

describe('the source carries the rest of the fix', () => {
  const src = readFileSync(new URL('../src/services/mirrorService.js', import.meta.url), 'utf8');

  test('the background mirror client now has a queue timeout', () => {
    expect(src).toMatch(/source: 'native-ticket-mirror',[\s\S]{0,400}queueTimeoutMs: MIRROR_QUEUE_TIMEOUT_MS/);
  });

  test('due_by is mirrored to FreshService', () => {
    expect(src).toMatch(/due_by: ticket\.dueBy \? new Date\(ticket\.dueBy\)\.toISOString\(\) : undefined/);
  });

  test('the mirror stays LOW priority so interactive work still jumps ahead', () => {
    expect(src).toMatch(/priority: 'low',\s*\n\s*source: 'native-ticket-mirror'/);
  });
});
