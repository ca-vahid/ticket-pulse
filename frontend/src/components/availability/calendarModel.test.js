import { describe, expect, test } from 'vitest';
import {
  coverageByDay, coverageTone, entrySegments, groupPeople, monthWeeks, nextWorkingDayKey, rangeDays, weekLanes, weekStartKey,
} from './calendarModel';

// October 2026: Thu 1, Sat 3, Sun 4, Mon 5, Mon 12 = Thanksgiving.
const OCT = rangeDays('2026-10-01', '2026-10-31');
const HOL = { '2026-10-12': 'Thanksgiving' };
const nonWorking = (d) => d.dow === 0 || d.dow === 6 || Boolean(HOL[d.key]);

describe('calendarModel', () => {
  test('a Friday-to-Tuesday leave is split around the weekend and the holiday', () => {
    const segs = entrySegments({ startDate: '2026-10-09', endDate: '2026-10-13' }, OCT, nonWorking);
    expect(segs).toEqual([{ start: 8, end: 8, first: true }, { start: 12, end: 12, first: false }]);
  });

  test('a single day booked on a Saturday stays on the Saturday', () => {
    expect(entrySegments({ startDate: '2026-10-03', endDate: '2026-10-03' }, OCT, nonWorking)).toEqual([{ start: 2, end: 2, first: true }]);
  });

  test('coverage counts approved time off only, one per person, never working from home or waiting requests', () => {
    const entries = [
      { email: 'a', startDate: '2026-10-05', endDate: '2026-10-06', status: 'approved', availability: 'OFF' },
      { email: 'a', startDate: '2026-10-05', endDate: '2026-10-05', status: 'approved', availability: 'OFF' },
      { email: 'b', startDate: '2026-10-05', endDate: '2026-10-05', status: 'approved', availability: 'WFH' },
      { email: 'c', startDate: '2026-10-05', endDate: '2026-10-05', status: 'pending', availability: 'OFF' },
    ];
    const cov = coverageByDay(entries, OCT, nonWorking);
    expect(cov.get('2026-10-05')).toEqual(['a']);
    expect(cov.get('2026-10-06')).toEqual(['a']);
    expect(coverageTone(0, 15)).toBe('none');
    expect(coverageTone(2, 15)).toBe('light');
    expect(coverageTone(4, 15)).toBe('medium');
    expect(coverageTone(5, 15)).toBe('heavy');
  });

  test('rows group by office (no office last) or by approval group (someone in two groups shows twice)', () => {
    const people = [{ email: 'a', officeId: 1 }, { email: 'b', officeId: 2 }, { email: 'c', officeId: null }];
    const offices = [{ id: 1, name: 'Vancouver' }, { id: 2, name: 'Calgary' }];
    expect(groupPeople(people, 'office', { offices }).map((s) => [s.label, s.people.map((p) => p.email)]))
      .toEqual([['Calgary', ['b']], ['Vancouver', ['a']], ['No office set', ['c']]]);
    const groups = [{ id: 7, name: 'Service desk' }, { id: 8, name: 'Infrastructure' }];
    const ids = { a: [7, 8], b: [8] };
    expect(groupPeople(people, 'group', { groups, groupIdsOf: (p) => ids[p.email] || [] }).map((s) => [s.label, s.people.map((p) => p.email)]))
      .toEqual([['Infrastructure', ['a', 'b']], ['Service desk', ['a']], ['Not in an approval group', ['c']]]);
  });

  test('weeks start on Monday; back to work skips the weekend and the holiday', () => {
    expect(weekStartKey('2026-10-04')).toBe('2026-09-28');
    const weeks = monthWeeks(2026, 9);
    expect(weeks[0][0]).toBe('2026-09-28');
    expect(weeks[weeks.length - 1][6]).toBe('2026-11-01');
    expect(nextWorkingDayKey('2026-10-09', new Set(['2026-10-12']))).toBe('2026-10-13');
  });

  test('month lanes stack overlapping leave', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const placed = weekLanes([
      { email: 'a', startDate: '2026-10-05', endDate: '2026-10-09' },
      { email: 'b', startDate: '2026-10-06', endDate: '2026-10-06' },
      { email: 'c', startDate: '2026-10-08', endDate: '2026-10-08' },
    ], week);
    expect(placed.map((p) => [p.entry.email, p.start, p.end, p.lane])).toEqual([['a', 0, 4, 0], ['b', 1, 1, 1], ['c', 3, 3, 1]]);
  });
});
