import { FreshServiceRateLimiter } from '../src/integrations/rateLimiter.js';

const makeJob = (name, launches) => () => {
  launches.push(name);
  return Promise.resolve(name);
};

describe('FreshServiceRateLimiter priority queues', () => {
  test('launches high-priority work ahead of already queued normal and low work', async () => {
    const limiter = new FreshServiceRateLimiter({
      maxRequestsPerMinute: 100,
      minDelayMs: 0,
      maxConcurrent: 10,
    });
    const launches = [];

    const low = limiter.enqueue(makeJob('low', launches), { priority: 'low' });
    const normal = limiter.enqueue(makeJob('normal', launches), { priority: 'normal' });
    const high = limiter.enqueue(makeJob('high', launches), { priority: 'high' });

    await Promise.all([low, normal, high]);

    expect(launches).toEqual(['high', 'normal', 'low']);
  });

  test('limits high-priority bursts so lower-priority work is not starved', async () => {
    const limiter = new FreshServiceRateLimiter({
      maxRequestsPerMinute: 100,
      minDelayMs: 0,
      maxConcurrent: 10,
      highBurstLimit: 2,
    });
    const launches = [];

    const jobs = [
      limiter.enqueue(makeJob('high-1', launches), { priority: 'high' }),
      limiter.enqueue(makeJob('high-2', launches), { priority: 'high' }),
      limiter.enqueue(makeJob('high-3', launches), { priority: 'high' }),
      limiter.enqueue(makeJob('normal-1', launches), { priority: 'normal' }),
      limiter.enqueue(makeJob('low-1', launches), { priority: 'low' }),
    ];

    await Promise.all(jobs);

    expect(launches).toEqual(['high-1', 'high-2', 'normal-1', 'high-3', 'low-1']);
  });

  test('reports queue depth by priority', async () => {
    const limiter = new FreshServiceRateLimiter({
      maxRequestsPerMinute: 100,
      minDelayMs: 0,
      maxConcurrent: 1,
    });
    limiter.processing = true;

    limiter.enqueue(makeJob('high', []), { priority: 'high' }).catch(() => {});
    limiter.enqueue(makeJob('normal', []), { priority: 'invalid' }).catch(() => {});
    limiter.enqueue(makeJob('low', []), { priority: 'low' }).catch(() => {});

    const stats = limiter.getStats();

    expect(stats.queueDepth).toBe(3);
    expect(stats.queueDepthByPriority).toEqual({ high: 1, normal: 1, low: 1 });
  });
});
