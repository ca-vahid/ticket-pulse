import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz';
import {
  DEFAULT_SETTINGS, SETTINGS_FIELDS,
  alignedAnchorDate, anchorDateFor, atWork, awayPhrase, coversInWindow, handoverInstant, leaveDaysInWindow,
  normalizeSettings, onCallUntil, onCallWeek, rangeLabel, rankResponders, resolveOnCall, responderPhrase,
  rowToSettings, sentenceFor, settingsToRow, uncoveredLeaveDays, upcomingWeeks, validateSettings, widensScope,
} from '../src/services/urgentResponse/rules.js';

/**
 * Urgent response — the pure rules (plans/URGENT_RESPONSE_PLAN.md): who is at
 * work, who is picked, the on-call week, covers, the sentence, the settings.
 * Every moment is passed in; nothing here reads the clock.
 *
 * October 2026: Sat 10, Mon 12, Mon 19, Mon 26; Sunday 1 Nov is the day the
 * US Pacific states put their clocks back.
 */
const LA = 'America/Los_Angeles';
const VANCOUVER = 'America/Vancouver';
const HOUR = 60 * 60 * 1000;
const local = (dateStr, time, tz = LA) => handoverInstant(dateStr, time, tz);
const leaveDay = (dateStr, extra = {}) => ({ leaveDate: new Date(`${dateStr}T00:00:00Z`), category: 'OFF', status: 'APPROVED', isFullDay: true, ...extra });

const DAVID = { id: 1, name: 'David Zapata', timezone: LA, workStartTime: '09:00', workEndTime: '17:00' };

describe('atWork', () => {
  test('inside the shift on a weekday', () => {
    expect(atWork(DAVID, local('2026-10-12', '10:00'))).toEqual({ atWork: true, reason: 'at_work', startsInMinutes: null, nextStartAt: null, nextStartLocal: null });
  });

  test('no shift on the row means 09:00–17:00', () => {
    const tech = { id: 2, timezone: LA, workStartTime: null, workEndTime: null };
    expect(atWork(tech, local('2026-10-12', '16:59')).atWork).toBe(true);
    expect(atWork(tech, local('2026-10-12', '17:00')).atWork).toBe(false);
  });

  test('before and after the shift say when they start next', () => {
    const before = atWork(DAVID, local('2026-10-12', '07:10'));
    expect(before).toMatchObject({ atWork: false, reason: 'before_shift', startsInMinutes: 110, nextStartLocal: '09:00' });
    expect(before.nextStartAt).toEqual(local('2026-10-12', '09:00'));
    const after = atWork(DAVID, local('2026-10-12', '18:00'));
    expect(after).toMatchObject({ atWork: false, reason: 'after_shift', startsInMinutes: 15 * 60 });
    expect(after.nextStartAt).toEqual(local('2026-10-13', '09:00'));
  });

  test('the weekend is not a business day; the next start is Monday', () => {
    const r = atWork(DAVID, local('2026-10-10', '10:00'));
    expect(r).toMatchObject({ atWork: false, reason: 'not_business_day', startsInMinutes: 47 * 60, nextStartLocal: '09:00' });
    expect(r.nextStartAt).toEqual(local('2026-10-12', '09:00'));
  });

  test('the caller decides what a business day is (a holiday Monday)', () => {
    const isBusinessDay = (dateStr, dow) => dow >= 1 && dow <= 5 && dateStr !== '2026-10-12';
    const r = atWork(DAVID, local('2026-10-12', '10:00'), { isBusinessDay });
    expect(r).toMatchObject({ atWork: false, reason: 'not_business_day' });
    expect(r.nextStartAt).toEqual(local('2026-10-13', '09:00'));
  });

  test('a full day of leave takes them away; WFH, ignored and unapproved rows do not', () => {
    const at = local('2026-10-12', '10:00');
    const away = atWork(DAVID, at, { leaves: [leaveDay('2026-10-12')] });
    expect(away).toMatchObject({ atWork: false, reason: 'on_leave' });
    expect(away.nextStartAt).toEqual(local('2026-10-13', '09:00'));
    expect(atWork(DAVID, at, { leaves: [leaveDay('2026-10-12', { category: 'WFH' })] }).atWork).toBe(true);
    expect(atWork(DAVID, at, { leaves: [leaveDay('2026-10-12', { category: 'IGNORED' })] }).atWork).toBe(true);
    expect(atWork(DAVID, at, { leaves: [leaveDay('2026-10-12', { status: 'PENDING' })] }).atWork).toBe(true);
    expect(atWork(DAVID, at, { leaves: [leaveDay('2026-10-13')] }).atWork).toBe(true);
    // `date` as a plain string works like the DATE column.
    expect(atWork(DAVID, at, { leaves: [{ date: '2026-10-12', category: 'OTHER', isFullDay: true }] }).reason).toBe('on_leave');
  });

  test('a half day takes them away inside its window only', () => {
    const leaves = [leaveDay('2026-10-12', { isFullDay: false, halfDayPart: 'AM', startMinute: 540, endMinute: 780 })];
    const morning = atWork(DAVID, local('2026-10-12', '10:00'), { leaves });
    expect(morning).toMatchObject({ atWork: false, reason: 'half_day_leave', startsInMinutes: 180, nextStartLocal: '13:00' });
    expect(atWork(DAVID, local('2026-10-12', '13:00'), { leaves }).atWork).toBe(true);
    expect(atWork(DAVID, local('2026-10-12', '14:00'), { leaves }).atWork).toBe(true);
    // Before the shift on that day they start when the leave ends, not at 09:00.
    expect(atWork(DAVID, local('2026-10-12', '08:00'), { leaves })).toMatchObject({ reason: 'before_shift', nextStartLocal: '13:00' });
  });

  test('a half day with no window recorded falls back to AM / PM', () => {
    const pm = [leaveDay('2026-10-12', { isFullDay: false, halfDayPart: 'PM', startMinute: null, endMinute: null })];
    expect(atWork(DAVID, local('2026-10-12', '10:00'), { leaves: pm }).atWork).toBe(true);
    expect(atWork(DAVID, local('2026-10-12', '13:00'), { leaves: pm }).reason).toBe('half_day_leave');
  });

  test('half-day minutes are read in the zone they were recorded in', () => {
    const toronto = { id: 3, name: 'Maria Lee', timezone: 'America/Toronto', workStartTime: '09:00', workEndTime: '17:00' };
    // 09:00–13:00 Pacific is 12:00–16:00 in Toronto.
    const leaves = [leaveDay('2026-10-12', { isFullDay: false, startMinute: 540, endMinute: 780 })];
    expect(atWork(toronto, local('2026-10-12', '11:00', 'America/Toronto'), { leaves, leaveTimezone: LA }).atWork).toBe(true);
    expect(atWork(toronto, local('2026-10-12', '13:00', 'America/Toronto'), { leaves, leaveTimezone: LA })).toMatchObject({ reason: 'half_day_leave', nextStartLocal: '16:00' });
  });

  test('an overnight shift belongs to the day it starts on', () => {
    const night = { id: 4, name: 'Noor', timezone: LA, workStartTime: '22:00', workEndTime: '06:00' };
    expect(atWork(night, local('2026-10-12', '23:00')).atWork).toBe(true); // Monday evening
    expect(atWork(night, local('2026-10-13', '02:00')).atWork).toBe(true); // still Monday's shift
    expect(atWork(night, local('2026-10-10', '02:00')).atWork).toBe(true); // Saturday small hours = Friday's shift
    expect(atWork(night, local('2026-10-12', '02:00'))).toMatchObject({ atWork: false, reason: 'not_business_day' }); // Sunday's shift
    expect(atWork(night, local('2026-10-12', '12:00'))).toMatchObject({ atWork: false, reason: 'before_shift', startsInMinutes: 600, nextStartLocal: '22:00' });
    // Leave on Monday covers the whole shift that starts on Monday, past midnight.
    expect(atWork(night, local('2026-10-13', '02:00'), { leaves: [leaveDay('2026-10-12')] }).reason).toBe('on_leave');
  });

  test('grace: starting within N minutes counts as at work', () => {
    const at = local('2026-10-12', '08:40');
    expect(atWork(DAVID, at, { graceMinutes: 30 })).toMatchObject({ atWork: true, reason: 'starts_soon', startsInMinutes: 20, nextStartLocal: '09:00' });
    expect(atWork(DAVID, at, { graceMinutes: 20 }).atWork).toBe(true);
    expect(atWork(DAVID, at, { graceMinutes: 10 })).toMatchObject({ atWork: false, reason: 'before_shift' });
    // Grace never reaches across a weekend or a day of leave.
    expect(atWork(DAVID, local('2026-10-10', '08:40'), { graceMinutes: 30 }).atWork).toBe(false);
    expect(atWork(DAVID, at, { graceMinutes: 30, leaves: [leaveDay('2026-10-12')] }).atWork).toBe(false);
  });

  test('the shift is in the technician own time zone', () => {
    const toronto = { id: 3, name: 'Maria Lee', timezone: 'America/Toronto', workStartTime: '09:00', workEndTime: '17:00' };
    const at = new Date('2026-10-12T13:30:00Z'); // 09:30 in Toronto, 06:30 on the Pacific coast
    expect(atWork(toronto, at).atWork).toBe(true);
    expect(atWork(DAVID, at)).toMatchObject({ atWork: false, reason: 'before_shift', startsInMinutes: 150 });
    // Sunday evening in Vancouver is already Monday morning in Sydney.
    const sydney = { id: 5, timezone: 'Australia/Sydney', workStartTime: '09:00', workEndTime: '17:00' };
    expect(atWork(sydney, local('2026-10-11', '16:00')).atWork).toBe(true);
  });

  test('an unknown zone does not throw', () => {
    expect(() => atWork({ id: 6, timezone: 'Not/AZone' }, local('2026-10-12', '10:00'))).not.toThrow();
  });

  test('awayPhrase gives the half-sentence used in notices', () => {
    expect(awayPhrase('David Zapata', atWork(DAVID, local('2026-10-12', '07:10')))).toBe('David starts at 09:00');
    expect(awayPhrase('David Zapata', atWork(DAVID, local('2026-10-12', '10:00'), { leaves: [leaveDay('2026-10-12')] }))).toBe('David is on leave');
    expect(awayPhrase('David Zapata', atWork(DAVID, local('2026-10-12', '10:00')))).toBe('David is at work');
  });
});

describe('rankResponders', () => {
  const c = (id, extra = {}) => ({ id, name: `T${id}`, atWork: true, awayReason: null, skill: 'none', openTickets: 0, lastAssignedAt: null, ...extra });

  test('the fixed order: at work, skill, open tickets, least recently given', () => {
    const ranked = rankResponders([
      c(1, { atWork: false, awayReason: 'on leave', skill: 'exact' }),
      c(2, { skill: 'none', openTickets: 0 }),
      c(3, { skill: 'category', openTickets: 1 }),
      c(4, { skill: 'exact', openTickets: 9 }),
      c(5, { skill: 'exact', openTickets: 2, lastAssignedAt: '2026-10-09T10:00:00Z' }),
      c(6, { skill: 'exact', openTickets: 2, lastAssignedAt: '2026-10-08T10:00:00Z' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ranked[0].why).toBe('at work, has the skill, fewest open tickets, least recently given a ticket');
    expect(ranked[2].why).toBe('at work, has the skill, 9 open tickets');
    expect(ranked[3].why).toBe('at work, has a skill in the category');
    expect(ranked[5].why).toBe('not at work (on leave)');
  });

  test('ties: never given a ticket beats any date, then the lower id', () => {
    const ranked = rankResponders([
      c(9, { lastAssignedAt: '2026-10-01T00:00:00Z' }),
      c(8, { lastAssignedAt: null }),
      c(7, { lastAssignedAt: null }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual([7, 8, 9]);
    // The same people in any order give the same answer.
    expect(rankResponders([c(7), c(9, { lastAssignedAt: '2026-10-01T00:00:00Z' }), c(8)]).map((r) => r.id)).toEqual([7, 8, 9]);
  });

  test('the plain winner on open tickets says so; the input is not changed', () => {
    const input = [c(1, { openTickets: 4 }), c(2, { openTickets: 1 })];
    const ranked = rankResponders(input);
    expect(ranked[0]).toMatchObject({ id: 2, why: 'at work, fewest open tickets' });
    expect(input.map((r) => r.id)).toEqual([1, 2]);
    expect(rankResponders([c(1)])[0].why).toBe('at work');
    expect(rankResponders(null)).toEqual([]);
  });

  test('responderPhrase', () => {
    expect(responderPhrase('Andrew Fong', { skill: 'exact', skillName: 'Network' })).toBe('Andrew is at work and has the Network skill');
    expect(responderPhrase('Andrew Fong', { skill: 'category' })).toBe('Andrew is at work and has the skill');
    expect(responderPhrase('Andrew Fong')).toBe('Andrew is at work');
  });
});

describe('the on-call week', () => {
  const SETTINGS = { onCallOrder: [11, 22, 33], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: '2026-10-12' };

  test('handoverInstant is the wall-clock time in the zone', () => {
    expect(handoverInstant('2026-10-12', '17:00', LA).toISOString()).toBe('2026-10-13T00:00:00.000Z');
    expect(handoverInstant('2026-11-02', '17:00', LA).toISOString()).toBe('2026-11-03T01:00:00.000Z');
    expect(formatInTimeZone(handoverInstant('2026-11-02', '17:00', VANCOUVER), VANCOUVER, 'EEE HH:mm')).toBe('Mon 17:00');
  });

  test('a week runs handover to handover; the order repeats', () => {
    const week = onCallWeek(SETTINGS, LA, local('2026-10-14', '09:00'));
    expect(week).toEqual({ index: 0, startsAt: local('2026-10-12', '17:00'), endsAt: local('2026-10-19', '17:00'), technicianId: 11 });
    expect(onCallWeek(SETTINGS, LA, local('2026-10-21', '09:00'))).toMatchObject({ index: 1, technicianId: 22 });
    expect(onCallWeek(SETTINGS, LA, local('2026-11-04', '09:00'))).toMatchObject({ index: 3, technicianId: 11 });
  });

  test('the handover day belongs to the outgoing person until the handover time', () => {
    expect(onCallWeek(SETTINGS, LA, local('2026-10-19', '16:59'))).toMatchObject({ index: 0, technicianId: 11 });
    expect(onCallWeek(SETTINGS, LA, local('2026-10-19', '17:00'))).toMatchObject({ index: 1, technicianId: 22 });
  });

  test('before the anchor the order runs backwards without going negative', () => {
    expect(onCallWeek(SETTINGS, LA, local('2026-10-12', '09:00'))).toMatchObject({ index: -1, technicianId: 33 });
    expect(onCallWeek(SETTINGS, LA, local('2026-09-30', '09:00'))).toMatchObject({ index: -2, technicianId: 22 });
  });

  test('1 Nov 2026 in Los Angeles: the week across the change is 169 hours, the handover stays at 17:00', () => {
    const week = onCallWeek(SETTINGS, LA, local('2026-10-28', '09:00'));
    expect(week.index).toBe(2);
    expect(week.technicianId).toBe(33);
    expect(week.startsAt.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(week.endsAt.toISOString()).toBe('2026-11-03T01:00:00.000Z');
    expect((week.endsAt - week.startsAt) / HOUR).toBe(169);
    // Sunday 1 Nov, both sides of 02:00, is still this week; the next one is 168 hours again.
    expect(onCallWeek(SETTINGS, LA, new Date('2026-11-01T08:30:00Z')).index).toBe(2);
    expect(onCallWeek(SETTINGS, LA, new Date('2026-11-01T10:30:00Z')).index).toBe(2);
    const next = onCallWeek(SETTINGS, LA, local('2026-11-02', '17:00'));
    expect(next.index).toBe(3);
    expect((next.endsAt - next.startsAt) / HOUR).toBe(168);
  });

  test('1 Nov 2026 in Vancouver: whatever the zone data says, the handover is Monday 17:00 local', () => {
    // British Columbia stopped changing its clocks; older zone data still moves
    // them on 1 Nov. Either way nothing here may assume an offset.
    const week = onCallWeek(SETTINGS, VANCOUVER, local('2026-10-28', '09:00', VANCOUVER));
    expect(week.index).toBe(2);
    expect(formatInTimeZone(week.startsAt, VANCOUVER, 'yyyy-MM-dd EEE HH:mm')).toBe('2026-10-26 Mon 17:00');
    expect(formatInTimeZone(week.endsAt, VANCOUVER, 'yyyy-MM-dd EEE HH:mm')).toBe('2026-11-02 Mon 17:00');
    const shift = (getTimezoneOffset(VANCOUVER, week.startsAt) - getTimezoneOffset(VANCOUVER, week.endsAt)) / HOUR;
    expect([0, 1]).toContain(shift);
    expect((week.endsAt - week.startsAt) / HOUR).toBe(168 + shift);
    const next = onCallWeek(SETTINGS, VANCOUVER, week.endsAt);
    expect(next.index).toBe(3);
    expect(next.startsAt).toEqual(week.endsAt);
    expect(formatInTimeZone(next.endsAt, VANCOUVER, 'EEE HH:mm')).toBe('Mon 17:00');
  });

  test('upcomingWeeks: contiguous weeks starting with the one that holds `from`', () => {
    for (const tz of [LA, VANCOUVER]) {
      const weeks = upcomingWeeks(SETTINGS, tz, local('2026-10-14', '09:00', tz), 8);
      expect(weeks).toHaveLength(8);
      expect(weeks.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(weeks.map((w) => w.technicianId)).toEqual([11, 22, 33, 11, 22, 33, 11, 22]);
      weeks.slice(1).forEach((w, i) => expect(w.startsAt).toEqual(weeks[i].endsAt));
      weeks.forEach((w) => expect(formatInTimeZone(w.startsAt, tz, 'EEE HH:mm')).toBe('Mon 17:00'));
    }
  });

  test('an anchor on another weekday moves forward to the handover day; no order = nobody', () => {
    expect(alignedAnchorDate({ ...SETTINGS, onCallAnchorDate: '2026-10-14' })).toBe('2026-10-19');
    expect(alignedAnchorDate({ ...SETTINGS, onCallAnchorDate: new Date('2026-10-12T00:00:00Z') })).toBe('2026-10-12');
    expect(onCallWeek({ ...SETTINGS, onCallOrder: [] }, LA, local('2026-10-14', '09:00')).technicianId).toBeNull();
    // No anchor saved: still a stable Monday 17:00 week.
    const loose = onCallWeek({ ...SETTINGS, onCallAnchorDate: null }, LA, local('2026-10-14', '09:00'));
    expect(loose.startsAt).toEqual(local('2026-10-12', '17:00'));
  });

  test('a Friday 08:30 handover', () => {
    const s = { onCallOrder: [1, 2], onCallHandoverDay: 5, onCallHandoverTime: '08:30', onCallAnchorDate: '2026-10-16' };
    const week = onCallWeek(s, LA, local('2026-10-16', '08:30'));
    expect(week).toMatchObject({ index: 0, technicianId: 1 });
    expect(onCallWeek(s, LA, local('2026-10-16', '08:29'))).toMatchObject({ index: -1, technicianId: 2 });
  });

  test('anchorDateFor: the handover on or before now', () => {
    expect(anchorDateFor(1, '17:00', LA, local('2026-10-14', '09:00'))).toBe('2026-10-12');
    expect(anchorDateFor(1, '17:00', LA, local('2026-10-12', '16:00'))).toBe('2026-10-05');
    expect(anchorDateFor(1, '17:00', LA, local('2026-10-12', '17:00'))).toBe('2026-10-12');
  });
});

describe('covers', () => {
  const SETTINGS = { onCallOrder: [11, 22, 33], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: '2026-10-12' };
  const week = onCallWeek(SETTINGS, LA, local('2026-10-14', '09:00'));
  const cover = (id, from, to, extra = {}) => ({ id, originalTechnicianId: 11, coverTechnicianId: 22, startsAt: from, endsAt: to, cancelledAt: null, ...extra });

  test('no cover: the scheduled person', () => {
    expect(resolveOnCall(week, [], local('2026-10-14', '09:00'))).toEqual({ technicianId: 11, scheduledTechnicianId: 11, cover: null });
    expect(onCallUntil(week, [], local('2026-10-14', '09:00'))).toEqual(week.endsAt);
  });

  test('a cover for the whole week', () => {
    const whole = cover(1, week.startsAt, week.endsAt);
    const r = resolveOnCall(week, [whole], local('2026-10-14', '09:00'));
    expect(r).toMatchObject({ technicianId: 22, scheduledTechnicianId: 11 });
    expect(r.cover.id).toBe(1);
    expect(resolveOnCall(week, [whole], week.startsAt).technicianId).toBe(22);
    expect(onCallUntil(week, [whole], local('2026-10-14', '09:00'))).toEqual(week.endsAt);
  });

  test('a cover for part of the week: before, inside, after', () => {
    const part = cover(2, local('2026-10-15', '00:00'), local('2026-10-17', '00:00'));
    expect(resolveOnCall(week, [part], local('2026-10-14', '09:00')).technicianId).toBe(11);
    expect(resolveOnCall(week, [part], local('2026-10-15', '00:00')).technicianId).toBe(22);
    expect(resolveOnCall(week, [part], local('2026-10-16', '23:59')).technicianId).toBe(22);
    expect(resolveOnCall(week, [part], local('2026-10-17', '00:00')).technicianId).toBe(11); // the end is exclusive
    expect(onCallUntil(week, [part], local('2026-10-14', '09:00'))).toEqual(local('2026-10-15', '00:00'));
    expect(onCallUntil(week, [part], local('2026-10-15', '09:00'))).toEqual(local('2026-10-17', '00:00'));
    expect(onCallUntil(week, [part], local('2026-10-17', '09:00'))).toEqual(week.endsAt);
  });

  test('a cancelled cover does not count; of two overlapping, the one made last wins', () => {
    const at = local('2026-10-14', '09:00');
    expect(resolveOnCall(week, [cover(1, week.startsAt, week.endsAt, { cancelledAt: new Date() })], at).technicianId).toBe(11);
    const two = [cover(1, week.startsAt, week.endsAt), cover(5, week.startsAt, week.endsAt, { coverTechnicianId: 33 })];
    expect(resolveOnCall(week, two, at).technicianId).toBe(33);
    expect(coversInWindow([...two, cover(9, week.endsAt, new Date(week.endsAt.getTime() + HOUR))], week.startsAt, week.endsAt).map((c) => c.id)).toEqual([1, 5]);
  });

  test('leave days inside the window: full days only, in the workspace zone', () => {
    const leaves = [
      leaveDay('2026-10-12'), // the handover day: the evening is inside the week
      leaveDay('2026-10-15'),
      leaveDay('2026-10-16', { isFullDay: false, startMinute: 540, endMinute: 780 }),
      leaveDay('2026-10-17', { category: 'WFH' }),
      leaveDay('2026-10-20'), // after the week
    ];
    expect(leaveDaysInWindow(leaves, week.startsAt, week.endsAt, LA)).toEqual(['2026-10-12', '2026-10-15']);
  });

  test('uncovered leave days: a whole-week cover clears them, a part cover clears its days', () => {
    const days = ['2026-10-15', '2026-10-16'];
    expect(uncoveredLeaveDays(days, [], week.startsAt, week.endsAt, LA)).toEqual(days);
    expect(uncoveredLeaveDays(days, [cover(1, week.startsAt, week.endsAt)], week.startsAt, week.endsAt, LA)).toEqual([]);
    const thursday = cover(2, local('2026-10-15', '00:00'), local('2026-10-16', '00:00'));
    expect(uncoveredLeaveDays(days, [thursday], week.startsAt, week.endsAt, LA)).toEqual(['2026-10-16']);
    // Two covers back to back span the day between them; a gap does not.
    const am = cover(3, local('2026-10-16', '00:00'), local('2026-10-16', '12:00'));
    const pm = cover(4, local('2026-10-16', '12:00'), local('2026-10-17', '00:00'));
    expect(uncoveredLeaveDays(days, [thursday, am, pm], week.startsAt, week.endsAt, LA)).toEqual([]);
    expect(uncoveredLeaveDays(days, [thursday, am], week.startsAt, week.endsAt, LA)).toEqual(['2026-10-16']);
    // Only the part of the handover day inside the week needs covering.
    const evening = cover(5, week.startsAt, local('2026-10-13', '00:00'));
    expect(uncoveredLeaveDays(['2026-10-12'], [evening], week.startsAt, week.endsAt, LA)).toEqual([]);
  });
});

describe('sentenceFor', () => {
  test('moved when it became urgent', () => {
    const ctx = { layer: 'raise', priority: 4, from: 'David Zapata', to: 'Andrew Fong', becameAt: '07:10', reason: 'David starts at 09:00', toWhy: 'Andrew is at work and has the Network skill' };
    expect(sentenceFor('moved', ctx)).toBe('Moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00. Andrew is at work and has the Network skill.');
    expect(sentenceFor('moved', { ...ctx, shadow: true })).toBe('Shadow: would have moved from David Zapata to Andrew Fong by the Urgent rule. Became Urgent at 07:10; David starts at 09:00. Andrew is at work and has the Network skill.');
    expect(sentenceFor('moved', { layer: 'raise', from: 'David Zapata', to: 'Andrew Fong' })).toBe('Moved from David Zapata to Andrew Fong by the Urgent rule.');
    expect(sentenceFor('moved', { ...ctx, priority: 3, toWhy: null })).toBe('Moved from David Zapata to Andrew Fong by the Urgent rule. Became High at 07:10; David starts at 09:00.');
  });

  test('redirected when assigning', () => {
    const ctx = { layer: 'assign', from: 'David Zapata', to: 'Andrew Fong', reason: 'David starts at 09:00' };
    expect(sentenceFor('redirected', ctx)).toBe('Assigned to Andrew Fong instead of David Zapata by the Urgent rule: David starts at 09:00.');
    expect(sentenceFor('redirected', { ...ctx, shadow: true })).toBe('Shadow: would have assigned to Andrew Fong instead of David Zapata by the Urgent rule: David starts at 09:00.');
  });

  test('the clock: team told, then moved', () => {
    expect(sentenceFor('team_told', { priority: 4, minutes: 15 })).toBe('Urgent and untouched for 15 minutes. The people at work were told.');
    expect(sentenceFor('team_told', { priority: 4, minutes: 15, shadow: true })).toBe('Shadow: would have told the people at work. Urgent and untouched for 15 minutes.');
    expect(sentenceFor('team_told', { priority: 3, minutes: 1 })).toBe('High and untouched for 1 minute. The people at work were told.');
    const move = { layer: 'clock', priority: 4, minutes: 30, from: 'Andrew Fong', to: 'Maria Lee', why: 'at work, fewest open tickets' };
    expect(sentenceFor('moved', move)).toBe('Urgent and untouched for 30 minutes. Moved from Andrew Fong to Maria Lee: at work, fewest open tickets.');
    expect(sentenceFor('moved', { ...move, shadow: true })).toBe('Shadow: would have moved from Andrew Fong to Maria Lee: at work, fewest open tickets. Urgent and untouched for 30 minutes.');
  });

  test('hand-assigned: tell only', () => {
    expect(sentenceFor('told_owner_away', { from: 'David Zapata' })).toBe('David Zapata is away and this ticket was assigned by hand, so it stays with them. The people at work were told.');
    expect(sentenceFor('told_owner_away', { from: 'David Zapata', shadow: true })).toBe('Shadow: would have told the people at work. David Zapata is away and this ticket was assigned by hand, so it stays with them.');
  });

  test('nobody at work: held', () => {
    expect(sentenceFor('held', { from: 'David Zapata', contact: 'Susan Xu' })).toBe('Nobody is at work. Left with David Zapata; Susan Xu was told.');
    expect(sentenceFor('held', { from: 'David Zapata' })).toBe('Nobody is at work. Left with David Zapata.');
    expect(sentenceFor('held', { from: 'David Zapata', contact: 'Susan Xu', shadow: true })).toBe('Shadow: would have left it with David Zapata and told Susan Xu. Nobody is at work.');
    expect(sentenceFor('held', { layer: 'assign', from: 'David Zapata' })).toBe('Nobody is at work. Left for review instead of assigning it to David Zapata.');
    expect(sentenceFor('held', { layer: 'assign', from: 'David Zapata', shadow: true })).toBe('Shadow: would have left it for review instead of assigning it to David Zapata. Nobody is at work.');
  });

  test('nobody at work: on-call', () => {
    expect(sentenceFor('on_call_assigned', { to: 'Andrew Fong' })).toBe('Nobody is at work. Assigned to the on-call person, Andrew Fong, who was texted.');
    expect(sentenceFor('on_call_assigned', { to: 'Andrew Fong', texted: false })).toBe('Nobody is at work. Assigned to the on-call person, Andrew Fong, who has no verified phone to text.');
    expect(sentenceFor('on_call_assigned', { to: 'Andrew Fong', shadow: true })).toBe('Shadow: would have assigned to the on-call person, Andrew Fong, and texted them. Nobody is at work.');
  });

  test('the end of the chain: the coordinator', () => {
    expect(sentenceFor('coordinator', { priority: 4, moves: 2, from: 'Maria Lee', to: 'Susan Xu' })).toBe('Urgent and still untouched after 2 moves. Assigned to the coordinator, Susan Xu, who was told.');
    expect(sentenceFor('coordinator', { priority: 4, moves: 2, from: 'Maria Lee', to: 'Susan Xu', shadow: true })).toBe('Shadow: would have assigned to the coordinator, Susan Xu. Urgent and still untouched after 2 moves.');
    expect(sentenceFor('coordinator', { priority: 4, moves: 1, from: 'Maria Lee' })).toBe('Urgent and still untouched after 1 move. No coordinator is set, so it stays with Maria Lee.');
  });

  test('undo', () => {
    expect(sentenceFor('undone', { to: 'David Zapata', actor: 'Vahid Haeri' })).toBe('Moved back to David Zapata by Vahid Haeri (undo).');
  });

  test('on-call cover', () => {
    expect(sentenceFor('cover_needed', { from: 'Andrew Fong', range: '12–19 Oct', days: ['2026-10-15', '2026-10-16'] })).toBe('Andrew Fong is on call 12–19 Oct and has leave on Thu 15 Oct and Fri 16 Oct. The week needs cover.');
    expect(sentenceFor('cover_requested', { from: 'Andrew Fong', range: '12–19 Oct', asked: 4 })).toBe('Cover asked for Andrew Fong, on call 12–19 Oct: 4 people asked.');
    expect(sentenceFor('cover_requested', { from: 'Andrew Fong', asked: 1 })).toBe('Cover asked for Andrew Fong, on call: 1 person asked.');
    expect(sentenceFor('cover_set', { from: 'Andrew Fong', to: 'Maria Lee', range: '12–19 Oct' })).toBe('Maria Lee covers on call for Andrew Fong, 12–19 Oct.');
  });

  test('failed, and an action nobody wrote a sentence for', () => {
    expect(sentenceFor('failed', { from: 'David Zapata', to: 'Andrew Fong', error: 'FreshService said no' })).toBe('Could not move this ticket from David Zapata to Andrew Fong: FreshService said no.');
    expect(sentenceFor('failed', {})).toBe('Could not move this ticket.');
    expect(sentenceFor('something_new')).toBe('Urgent rule: something new.');
  });

  test('every sentence ends with one full stop', () => {
    for (const action of ['redirected', 'held', 'moved', 'told_owner_away', 'team_told', 'coordinator', 'on_call_assigned', 'undone', 'cover_needed', 'cover_requested', 'cover_set', 'failed']) {
      for (const shadow of [false, true]) {
        const s = sentenceFor(action, { shadow, from: 'A B', to: 'C D', reason: 'A starts at 09:00.', why: 'at work', minutes: 5, moves: 2 });
        expect(s.endsWith('.')).toBe(true);
        expect(s.includes('..')).toBe(false);
        if (shadow && !['undone', 'cover_needed', 'cover_requested', 'cover_set', 'failed'].includes(action)) expect(s.startsWith('Shadow: would have ')).toBe(true);
      }
    }
  });

  test('rangeLabel', () => {
    expect(rangeLabel(local('2026-10-12', '17:00'), local('2026-10-19', '17:00'), LA)).toBe('12–19 Oct');
    expect(rangeLabel(local('2026-10-26', '17:00'), local('2026-11-02', '17:00'), LA)).toBe('26 Oct – 2 Nov');
  });
});

describe('settings', () => {
  test('the defaults are the decisions in the plan, and they are valid', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      mode: 'off', assignPriorities: [4, 3], raisePriorities: [4], clockPriorities: [4], assignGraceMinutes: 30,
      clockNotifyMinutes: 15, clockMoveMinutes: 30, maxMoves: 2, raiseManualAction: 'notify', nobodyMode: 'hold',
      notifyAudience: 'on_shift', notifyChannels: ['teams', 'email'], onCallHandoverDay: 1, onCallHandoverTime: '17:00',
    });
    expect(validateSettings(normalizeSettings({}))).toEqual([]);
    expect(normalizeSettings()).toEqual(normalizeSettings(DEFAULT_SETTINGS));
    expect(Object.keys(normalizeSettings({}))).toEqual([...SETTINGS_FIELDS]);
  });

  test('normalizeSettings coerces types and keeps what it cannot fix', () => {
    const s = normalizeSettings({
      mode: ' live ', assignPriorities: ['3', 4, 4], clockNotifyMinutes: '20', notifyChannels: ['Teams', 'teams'], onCallOrder: ['5', 5, 7],
      coordinatorTechnicianId: '', nobodyContactTechnicianId: '12', raiseEnabled: 'false', onCallAnchorDate: new Date('2026-10-12T00:00:00Z'), junk: 1,
    });
    expect(s).toMatchObject({
      mode: 'live', assignPriorities: [4, 3], clockNotifyMinutes: 20, notifyChannels: ['teams'], onCallOrder: [5, 7],
      coordinatorTechnicianId: null, nobodyContactTechnicianId: 12, raiseEnabled: false, onCallAnchorDate: '2026-10-12',
    });
    expect(s.junk).toBeUndefined();
    // Not corrected, so validation can say what is wrong.
    expect(normalizeSettings({ clockMoveMinutes: 'soon' }).clockMoveMinutes).toBeNaN();
    expect(normalizeSettings({ mode: 'bogus' }).mode).toBe('bogus');
  });

  const errorsFor = (patch) => validateSettings(normalizeSettings(patch));

  test.each([
    [{ mode: 'bogus' }, 'Mode must be one of'],
    [{ clockNotifyMinutes: 0 }, 'between 1 and 480'],
    [{ clockMoveMinutes: 481 }, 'between 1 and 480'],
    [{ clockNotifyMinutes: 1.5 }, 'whole number'],
    [{ clockNotifyMinutes: 30, clockMoveMinutes: 20 }, 'cannot be shorter'],
    [{ assignGraceMinutes: -1 }, 'Grace'],
    [{ assignPriorities: [4, 2] }, 'When assigning: priorities can only be Urgent or High'],
    [{ raisePriorities: [] }, 'When it becomes urgent: pick at least one priority'],
    [{ clockPriorities: [1] }, 'If nobody touches it: priorities can only be Urgent or High'],
    [{ notifyChannels: ['sms'] }, 'Channels can only be Teams and e-mail'],
    [{ notifyAudience: 'everyone' }, 'Who is told'],
    [{ notifyAudience: 'named' }, 'name at least one person'],
    [{ notifyTechnicianIds: [0] }, 'named people are not valid'],
    [{ raiseManualAction: 'ignore' }, 'Hand-assigned'],
    [{ nobodyMode: 'panic' }, 'Nobody at work'],
    [{ nobodyMode: 'on_call' }, 'set the on-call order'],
    [{ maxMoves: 11 }, 'number of moves'],
    [{ onCallHandoverDay: 7 }, 'handover day'],
    [{ onCallHandoverTime: '5pm' }, 'HH:MM'],
    [{ onCallHandoverTime: '24:00' }, 'HH:MM'],
    [{ onCallAnchorDate: 'next monday' }, 'first handover date'],
    [{ onCallOrder: [3, -1] }, 'on-call order is not valid'],
    [{ coordinatorTechnicianId: 'abc' }, 'coordinator is not valid'],
  ])('%j is refused', (patch, message) => {
    const errors = errorsFor(patch);
    expect(errors.join(' | ')).toContain(message);
  });

  test.each([
    [{ clockNotifyMinutes: 30, clockMoveMinutes: 30 }],
    [{ clockNotifyMinutes: 1, clockMoveMinutes: 480 }],
    [{ raiseEnabled: false, raisePriorities: [] }],
    [{ assignPriorities: [3] }],
    [{ notifyChannels: [] }],
    [{ notifyAudience: 'named', notifyTechnicianIds: [4] }],
    [{ nobodyMode: 'on_call', onCallOrder: [4, 5] }],
    [{ assignGraceMinutes: 0, maxMoves: 0 }],
    [{ onCallHandoverDay: 0, onCallHandoverTime: '00:00', onCallAnchorDate: '2026-10-11' }],
  ])('%j is accepted', (patch) => {
    expect(errorsFor(patch)).toEqual([]);
  });

  test('a row maps to the JSON and back', () => {
    const row = {
      workspaceId: 1, mode: 'observe', assignEnabled: true, assignPriorities: [4, 3], assignGraceMinutes: 30, raiseEnabled: true, raisePriorities: [4],
      raiseManualAction: 'notify', clockEnabled: true, clockPriorities: [4], clockNotifyMinutes: 15, clockMoveMinutes: 30, notifyAudience: 'on_shift',
      notifyTechnicianIds: [], notifyChannels: ['teams', 'email'], nobodyMode: 'hold', nobodyContactTechnicianId: null, coordinatorTechnicianId: 9, maxMoves: 2,
      onCallOrder: [11, 22], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: new Date('2026-10-12T00:00:00Z'),
      baselinedAt: null, updatedBy: 'a@b.c', createdAt: new Date(), updatedAt: new Date(),
    };
    const settings = rowToSettings(row);
    expect(settings).toMatchObject({ mode: 'observe', coordinatorTechnicianId: 9, onCallOrder: [11, 22], onCallAnchorDate: '2026-10-12' });
    expect(settings.updatedBy).toBeUndefined();
    expect(rowToSettings(null)).toEqual(normalizeSettings({}));
    const data = settingsToRow(settings);
    expect(data.onCallAnchorDate).toEqual(new Date('2026-10-12T00:00:00.000Z'));
    expect(settingsToRow(normalizeSettings({})).onCallAnchorDate).toBeNull();
    expect(Object.keys(data)).toEqual([...SETTINGS_FIELDS]);
  });

  test('widensScope: leaving off, changing mode, or bringing a priority into layers 2 and 3', () => {
    const base = normalizeSettings({ mode: 'observe' });
    expect(widensScope(normalizeSettings({}), base)).toBe(true); // off → Shadow
    expect(widensScope(base, { ...base, mode: 'live' })).toBe(true); // Shadow → Live
    expect(widensScope(base, { ...base, mode: 'off' })).toBe(false);
    expect(widensScope(base, { ...base, clockPriorities: [4, 3] })).toBe(true);
    expect(widensScope({ ...base, clockEnabled: false, raiseEnabled: false }, base)).toBe(true);
    expect(widensScope(base, { ...base, clockNotifyMinutes: 5 })).toBe(false);
    expect(widensScope(base, { ...base, assignPriorities: [4] })).toBe(false); // layer 1 has no clock
    expect(widensScope({ ...base, clockPriorities: [4, 3] }, base)).toBe(false);
  });
});
