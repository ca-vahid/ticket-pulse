import { jest } from '@jest/globals';

/**
 * FreshService budget (Vahid, 25 Sep 2026): Enterprise allows 500 requests a
 * minute account-wide with per-operation sub-limits; Ticket Pulse used a fixed
 * 110. The limiter now self-tunes (-20% on a 429, +10/min after 10 quiet
 * minutes, floor/ceiling) and caps each sub-limited operation on its own.
 */

jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { FreshServiceRateLimiter } = await import('../src/integrations/rateLimiter.js');
const { fsOperationClass, FS_CLASS_CAPS } = await import('../src/integrations/freshservice.js');

describe('fsOperationClass', () => {
  test('maps requests to FreshService sub-limits', () => {
    expect(fsOperationClass('get', '/tickets')).toBe('ticket_list');
    expect(fsOperationClass('get', '/tickets/filter?query=x')).toBe('ticket_list');
    expect(fsOperationClass('get', '/tickets/244152')).toBe('ticket_view');
    expect(fsOperationClass('put', '/tickets/244152')).toBe('ticket_write');
    expect(fsOperationClass('post', '/tickets')).toBe('ticket_write');
    expect(fsOperationClass('get', '/agents')).toBe('agent_list');
    expect(fsOperationClass('get', '/requesters')).toBe('requester_list');
    // No sub-limit: only the account-wide cap applies.
    expect(fsOperationClass('get', '/tickets/244152/conversations')).toBeNull();
    expect(fsOperationClass('get', '/tickets/244152/activities')).toBeNull();
  });

  test('every sub-limit cap stays under FreshService Enterprise (140 list / 160 view-write)', () => {
    expect(FS_CLASS_CAPS.ticket_list).toBeLessThan(140);
    expect(FS_CLASS_CAPS.ticket_view).toBeLessThan(160);
    expect(FS_CLASS_CAPS.ticket_write).toBeLessThan(160);
    expect(FS_CLASS_CAPS.agent_list).toBeLessThan(140);
  });
});

describe('FreshServiceRateLimiter — per-class caps and self-tuning', () => {
  beforeEach(() => { jest.useFakeTimers({ now: new Date('2026-09-25T20:00:00Z') }); });
  afterEach(() => { jest.useRealTimers(); });

  test('a class at its cap waits; other work keeps flowing past it', async () => {
    const limiter = new FreshServiceRateLimiter({ maxRequestsPerMinute: 100, minDelayMs: 0, maxConcurrent: 10, classCaps: { ticket_view: 2 } });
    const launched = [];
    const job = (name) => () => { launched.push(name); return Promise.resolve(name); };
    limiter.enqueue(job('view1'), { opClass: 'ticket_view' });
    limiter.enqueue(job('view2'), { opClass: 'ticket_view' });
    const third = limiter.enqueue(job('view3'), { opClass: 'ticket_view' });
    limiter.enqueue(job('conv1'), {});
    await jest.advanceTimersByTimeAsync(1000);
    expect(launched).toEqual(['view1', 'view2', 'conv1']);
    await jest.advanceTimersByTimeAsync(60 * 1000);
    await expect(third).resolves.toBe('view3');
    expect(launched).toContain('view3');
  });

  test('a 429 cuts the cap by 20% (one cut per burst, never below the floor)', () => {
    const limiter = new FreshServiceRateLimiter({ maxRequestsPerMinute: 200, ceilingPerMinute: 300, floorPerMinute: 100 });
    limiter.on429({ 'retry-after': '2' });
    expect(limiter.maxRequestsPerMinute).toBe(160);
    limiter.on429({ 'retry-after': '2' }); // same burst
    expect(limiter.maxRequestsPerMinute).toBe(160);
    for (let i = 0; i < 10; i++) {
      jest.setSystemTime(Date.now() + 6000);
      limiter.on429({ 'retry-after': '1' });
    }
    expect(limiter.maxRequestsPerMinute).toBe(100);
    expect(limiter.getStats()).toMatchObject({ floorPerMinute: 100, ceilingPerMinute: 300 });
  });

  test('after 10 quiet minutes it climbs 10 a minute back to the ceiling, not beyond', () => {
    const limiter = new FreshServiceRateLimiter({ maxRequestsPerMinute: 200, ceilingPerMinute: 230, floorPerMinute: 100 });
    limiter.on429({ 'retry-after': '1' });
    expect(limiter.maxRequestsPerMinute).toBe(160);
    const t0 = Date.now();
    limiter._retune(t0 + 5 * 60 * 1000);
    expect(limiter.maxRequestsPerMinute).toBe(160); // still within the 10 quiet minutes
    for (let i = 0; i < 20; i++) limiter._retune(t0 + 11 * 60 * 1000 + i * 61 * 1000);
    expect(limiter.maxRequestsPerMinute).toBe(230);
  });
});
