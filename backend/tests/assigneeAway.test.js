import { describe, expect, test } from '@jest/globals';
import { awayAtNextWorkingMoment } from '../src/services/assigneeAwayService.js';

/**
 * Vahid, 31 Oct 2026: warn when assigning to someone who is away at the next
 * working moment. "It's Sunday and Sam is coming back on Monday: no nag. It's
 * Sunday and Sam is taking Monday off: I should get a notice."
 * Calendar: Mon–Fri, 08:30–17:00, Wed 11 Nov 2026 (Remembrance Day) a holiday.
 */
const isWorkingDay = (d) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 && d !== '2026-11-11';
};
const endTimeOf = () => '17:00';
const at = (today, nowTime, days) => awayAtNextWorkingMoment({ offDates: new Set(days), today, nowTime, isWorkingDay, endTimeOf });

describe('away at the next working moment', () => {
  test('Sunday, off Mon 2 Nov to Fri 13 Nov: away, back Mon 16 Nov, 9 working days (holiday skipped)', () => {
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'];
    expect(at('2026-11-01', '10:00', days)).toEqual({ firstDay: '2026-11-02', lastDay: '2026-11-13', backOn: '2026-11-16', workingDaysAway: 9, fromToday: false });
  });

  test('Sunday, the week off was last week and Monday is a working day: no warning', () => {
    expect(at('2026-11-01', '10:00', ['2026-10-26', '2026-10-30'])).toBeNull();
  });

  test('Sunday, off only Monday: a warning, back Tuesday', () => {
    expect(at('2026-11-01', '22:00', ['2026-11-02'])).toMatchObject({ firstDay: '2026-11-02', backOn: '2026-11-03', workingDaysAway: 1 });
  });

  test('a weekday during business hours counts today', () => {
    expect(at('2026-11-02', '09:15', ['2026-11-02'])).toMatchObject({ firstDay: '2026-11-02', fromToday: true });
    expect(at('2026-11-02', '09:15', ['2026-11-03'])).toBeNull();
  });

  test('a weekday evening looks at the next working day instead', () => {
    expect(at('2026-11-02', '18:30', ['2026-11-02'])).toBeNull();
    expect(at('2026-11-02', '18:30', ['2026-11-03'])).toMatchObject({ firstDay: '2026-11-03', backOn: '2026-11-04' });
  });

  test('Friday evening, off Monday: a warning', () => {
    expect(at('2026-11-06', '17:30', ['2026-11-09'])).toMatchObject({ firstDay: '2026-11-09', backOn: '2026-11-10' });
  });

  test('the day before a holiday, off the day after it: the holiday is skipped', () => {
    expect(at('2026-11-10', '19:00', ['2026-11-12'])).toMatchObject({ firstDay: '2026-11-12', backOn: '2026-11-13' });
  });

  test('a leave that runs past the look-ahead has no back date', () => {
    const days = [];
    for (let i = 0; i < 200; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10);
      days.push(d);
    }
    expect(at('2026-11-02', '09:00', days).backOn).toBeNull();
  });
});
