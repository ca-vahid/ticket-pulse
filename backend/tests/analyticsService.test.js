import {
  buildInsight,
  calculateDelta,
  parseAnalyticsRange,
  summarizeNumeric,
} from '../src/services/analyticsService.js';

describe('analyticsService pure helpers', () => {
  test('parseAnalyticsRange defaults to a 30-day window with previous comparison', () => {
    const range = parseAnalyticsRange(
      { timezone: 'America/Los_Angeles' },
      new Date('2026-04-26T19:00:00.000Z'),
    );

    expect(range.range).toBe('30d');
    expect(range.groupBy).toBe('day');
    expect(range.compare).toBe('previous');
    expect(range.startDate).toBe('2026-03-28');
    expect(range.endDate).toBe('2026-04-26');
    expect(range.previousStartDate).toBe('2026-02-26');
    expect(range.previousEndDate).toBe('2026-03-27');
  });

  test('parseAnalyticsRange accepts custom ranges and swaps reversed dates safely', () => {
    const range = parseAnalyticsRange({
      range: 'custom',
      start: '2026-04-15',
      end: '2026-04-01',
      timezone: 'America/Vancouver',
      groupBy: 'week',
      compare: 'none',
    });

    expect(range.startDate).toBe('2026-04-01');
    expect(range.endDate).toBe('2026-04-15');
    expect(range.groupBy).toBe('week');
    expect(range.compare).toBe('none');
  });

  test('calculateDelta preserves null percent when previous period is zero', () => {
    expect(calculateDelta(12, 0)).toEqual({
      current: 12,
      previous: 0,
      change: 12,
      pct: null,
    });
  });

  test('summarizeNumeric ignores invalid values and returns stable percentiles', () => {
    expect(summarizeNumeric([30, null, 10, -1, Number.NaN, 20, 40])).toEqual({
      count: 4,
      avg: 25,
      median: 20,
      p90: 40,
      min: 10,
      max: 40,
    });
  });

  test('buildInsight returns explainable deterministic card shape', () => {
    const insight = buildInsight({
      id: 'overdue-risk',
      title: 'Open tickets are past due',
      severity: 'warning',
      rule: 'Open/Pending tickets with dueBy earlier than now.',
      evidenceCount: 3,
      affected: ['Current open queue'],
      drilldown: [{ id: 1 }],
    });

    expect(insight).toMatchObject({
      id: 'overdue-risk',
      severity: 'warning',
      evidenceCount: 3,
      affected: ['Current open queue'],
      drilldown: [{ id: 1 }],
    });
    expect(insight.rule).toContain('dueBy');
  });
});
