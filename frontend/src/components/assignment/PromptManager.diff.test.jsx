/** @vitest-environment jsdom */
import { describe, expect, test } from 'vitest';
import { buildLineDiff } from './promptDiff';

describe('buildLineDiff', () => {
  test('pairs changed lines and preserves line numbers', () => {
    const diff = buildLineDiff('alpha\nbeta\ngamma', 'alpha\nbeta changed\ngamma\nnew line');

    expect(diff).toEqual([
      expect.objectContaining({ type: 'equal', leftLine: 1, rightLine: 1, left: 'alpha', right: 'alpha' }),
      expect.objectContaining({ type: 'changed', leftLine: 2, rightLine: 2, left: 'beta', right: 'beta changed' }),
      expect.objectContaining({ type: 'equal', leftLine: 3, rightLine: 3, left: 'gamma', right: 'gamma' }),
      expect.objectContaining({ type: 'added', leftLine: null, rightLine: 4, right: 'new line' }),
    ]);
  });
});
