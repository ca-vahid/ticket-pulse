import { describe, expect, test } from '@jest/globals';

const { wrapFreshServiceError } = await import('../src/integrations/freshservice.js');
const { isQueueTimeout } = await import('../src/services/mirrorService.js');

describe('wrapFreshServiceError', () => {
  test('keeps the queue-timeout code so the mirror defers instead of failing', () => {
    const queued = Object.assign(new Error('FreshService request timed out after 90s waiting in the rate-limit queue (169 queued, 0 in-flight) — the request was never sent'), { code: 'FS_QUEUE_TIMEOUT' });
    const wrapped = wrapFreshServiceError(queued);
    expect(wrapped.code).toBe('FS_QUEUE_TIMEOUT');
    expect(isQueueTimeout(wrapped)).toBe(true);
  });

  test('does not copy other error codes', () => {
    const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
      code: 'ERR_BAD_REQUEST',
      response: { status: 400, data: { description: 'Validation failed', errors: [{ field: 'agent_group_id', message: "Assigned agent isn't a member of the group." }] } },
    });
    const wrapped = wrapFreshServiceError(axiosLike);
    expect(wrapped.code).toBeUndefined();
    expect(isQueueTimeout(wrapped)).toBe(false);
    expect(wrapped.message).toContain('agent_group_id');
  });
});
