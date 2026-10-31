/**
 * 31 Oct 2026: grouped copies (the same alert again) count as Repeats in Analytics,
 * not as noise, and each ticket lands in one bucket.
 */
import { isGroupedCopy, shareOf, GROUPED_COPY_WHERE, NOT_GROUPED_COPY_WHERE } from '../src/utils/groupedCopy.js';

describe('grouped copies', () => {
  test('only a "Grouped:" match is a repeat', () => {
    expect(isGroupedCopy({ noiseRuleMatched: 'Grouped: same request as TP-10582' })).toBe(true);
    expect(isGroupedCopy({ noiseRuleMatched: 'Darktrace digest' })).toBe(false);
    expect(isGroupedCopy({ noiseRuleMatched: null })).toBe(false);
    expect(isGroupedCopy(null)).toBe(false);
  });

  test('noise and repeats never overlap and share one denominator', () => {
    const tickets = [
      { isNoise: true, noiseRuleMatched: 'Grouped: same request as TP-1' },
      { isNoise: true, noiseRuleMatched: 'Spam rule' },
      { isNoise: false, noiseRuleMatched: null },
      { isNoise: false, noiseRuleMatched: null },
    ];
    const repeats = tickets.filter((t) => t.isNoise && isGroupedCopy(t)).length;
    const noise = tickets.filter((t) => t.isNoise && !isGroupedCopy(t)).length;
    expect(repeats + noise).toBe(tickets.filter((t) => t.isNoise).length);
    expect(shareOf(noise, tickets.length)).toEqual({ count: 1, pct: 25 });
    expect(shareOf(repeats, tickets.length)).toEqual({ count: 1, pct: 25 });
    expect(shareOf(0, 0)).toEqual({ count: 0, pct: 0 });
  });

  test('the Prisma filters are each other\'s complement on the prefix', () => {
    expect(GROUPED_COPY_WHERE).toEqual({ noiseRuleMatched: { startsWith: 'Grouped:' } });
    expect(NOT_GROUPED_COPY_WHERE.OR).toEqual([{ noiseRuleMatched: null }, { NOT: { noiseRuleMatched: { startsWith: 'Grouped:' } } }]);
  });
});
