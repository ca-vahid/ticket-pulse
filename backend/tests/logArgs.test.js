/**
 * Hourly review, 18 Sep 2026 — production logged
 *   SSE workspace validation failed (DB); allowing stream: { "0": "D", "1": "a", "2": "t", … }
 * because winston spreads a bare string passed as metadata one character per
 * key. foldPrimitiveMeta folds such primitives into the message instead.
 */
import { foldPrimitiveMeta } from '../src/utils/logArgs.js';

describe('foldPrimitiveMeta', () => {
  test('the production case: an error message string joins the message', () => {
    expect(foldPrimitiveMeta('SSE workspace validation failed (DB); allowing stream:', ['Database unavailable']))
      .toEqual(['SSE workspace validation failed (DB); allowing stream: Database unavailable']);
  });

  test('a message alone passes through untouched', () => {
    expect(foldPrimitiveMeta('plain', [])).toEqual(['plain']);
    expect(foldPrimitiveMeta('plain')).toEqual(['plain']);
  });

  test('objects, arrays and Errors stay metadata', () => {
    const meta = { ticketId: 7 };
    const err = new Error('boom');
    expect(foldPrimitiveMeta('with object', [meta])).toEqual(['with object', meta]);
    expect(foldPrimitiveMeta('with error', [err])).toEqual(['with error', err]);
    expect(foldPrimitiveMeta('with array', [[1, 2]])).toEqual(['with array', [1, 2]]);
  });

  test('a string followed by an object: the string folds, the object stays', () => {
    const meta = { workspaceId: 1 };
    expect(foldPrimitiveMeta('failed:', ['timeout', meta])).toEqual(['failed: timeout', meta]);
  });

  test('numbers and booleans fold too', () => {
    expect(foldPrimitiveMeta('count:', [3])).toEqual(['count: 3']);
    expect(foldPrimitiveMeta('enabled:', [false])).toEqual(['enabled: false']);
  });

  test('printf-style calls are left to winston splat', () => {
    expect(foldPrimitiveMeta('took %d ms', [42])).toEqual(['took %d ms', 42]);
    expect(foldPrimitiveMeta('hello %s', ['world'])).toEqual(['hello %s', 'world']);
  });

  test('a literal percent sign that is not a token still folds', () => {
    expect(foldPrimitiveMeta('cpu at 90% —', ['high'])).toEqual(['cpu at 90% — high']);
  });

  test('null and undefined are not folded (they are not messages)', () => {
    expect(foldPrimitiveMeta('x', [null])).toEqual(['x', null]);
    expect(foldPrimitiveMeta('x', [undefined])).toEqual(['x', undefined]);
  });
});
