import { describe, expect, test } from '@jest/globals';
import logger, { safeMetaString } from '../src/utils/logger.js';

/**
 * 28 Sep 2026: logger.error('…', axiosError) threw "Converting circular
 * structure to JSON" from the console format, and that TypeError replaced the
 * real FreshService 404 in the caller.
 */
function httpLikeError() {
  class ClientRequest {}
  class IncomingMessage {}
  const req = new ClientRequest();
  const res = new IncomingMessage();
  req.res = res;
  res.req = req;
  const err = new Error('Request failed with status code 404');
  err.request = req;
  err.response = { status: 404, data: { code: 'not_found' }, request: req };
  return err;
}

describe('safeMetaString', () => {
  test('plain metadata is unchanged', () => {
    expect(safeMetaString({ a: 1, b: 'x' })).toBe(JSON.stringify({ a: 1, b: 'x' }, null, 2));
  });

  test('a circular HTTP error serialises instead of throwing, keeping the useful parts', () => {
    const out = safeMetaString({ error: httpLikeError() });
    expect(out).toContain('"status": 404');
    expect(out).toContain('[ClientRequest]');
  });

  test('a plain circular object is marked, not thrown', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(safeMetaString({ a })).toContain('[Circular]');
  });
});

describe('logger with a circular error', () => {
  test('logger.error does not throw', () => {
    expect(() => logger.error('Error fetching conversations for ticket 215684:', httpLikeError())).not.toThrow();
    expect(() => logger.warn('meta', { err: httpLikeError() })).not.toThrow();
  });
});
