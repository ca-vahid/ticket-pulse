import { describe, expect, test } from 'vitest';
import {
  allSegments, buildIcs, currentStretch, dayWords, durationWords, hueMap, hueOf, localDateOf, monthGrids, myTurn,
  nextOwnWeek, progressOf, solid, startsInWords, tint, weekWord,
} from './onCallSchedule';

// The on-call page's arithmetic: colours, "how long is left", month grids and
// the calendar file. October 2026, Vancouver: handover Monday 17:00 = 00:00 UTC Tuesday.

const at = (iso) => new Date(iso).getTime();
const WEEKS = [
  {
    index: 0, startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-13T00:00:00.000Z', scheduled: { id: 3, name: 'Andrew Fong' },
    segments: [
      { technicianId: 3, startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-10T00:00:00.000Z', cover: false },
      { technicianId: 7, startsAt: '2026-10-10T00:00:00.000Z', endsAt: '2026-10-13T00:00:00.000Z', cover: true },
    ],
  },
  { index: 1, startsAt: '2026-10-13T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z', scheduled: { id: 7, name: 'Maria Lee' } },
  { index: 2, startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-27T00:00:00.000Z', scheduled: { id: 12, name: 'Dana Agent' } },
];

describe('colours', () => {
  test('one hue per person, the rotation order first, and the same person never twice', () => {
    const hues = hueMap([3, 7, 12], [7, 99, null]);
    expect([...hues.keys()]).toEqual(['3', '7', '12', '99']);
    expect(new Set(hues.values()).size).toBe(4);
    expect(hueOf(hues, 7)).toBe(hueOf(hues, '7'));
    expect(hueOf(hues, 1000)).toBeNull();
    expect(hueOf(hues, null)).toBeNull();
  });

  test('more people than hues wraps round instead of running out', () => {
    const hues = hueMap(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(hueOf(hues, 9)).toBe(hueOf(hues, 1));
  });

  test('nobody is a neutral token, never a colour of its own', () => {
    expect(tint(null)).toContain('--muted');
    expect(solid(null)).toContain('--muted-foreground');
    expect(tint(221, 0.2)).toBe('hsl(221 80% 55% / 0.2)');
  });
});

describe('time in words', () => {
  test('how long is left', () => {
    const now = at('2026-10-10T00:00:00Z');
    expect(durationWords(now, at('2026-10-12T03:00:00Z'))).toBe('2 days 3 hours');
    expect(durationWords(now, at('2026-10-11T00:00:00Z'))).toBe('1 day');
    expect(durationWords(now, at('2026-10-10T05:10:00Z'))).toBe('5 hours 10 minutes');
    expect(durationWords(now, at('2026-10-10T01:00:00Z'))).toBe('1 hour');
    expect(durationWords(now, at('2026-10-10T00:12:30Z'))).toBe('13 minutes');
    expect(durationWords(now, at('2026-10-10T00:00:20Z'))).toBe('less than a minute');
    expect(durationWords(now, now)).toBe('');
  });

  test('when something starts', () => {
    const now = at('2026-10-10T00:00:00Z');
    expect(startsInWords('2026-10-09T00:00:00Z', now)).toBe('now');
    expect(startsInWords('2026-10-10T00:20:00Z', now)).toBe('in 20 minutes');
    expect(startsInWords('2026-10-10T05:00:00Z', now)).toBe('in 5 hours');
    expect(startsInWords('2026-10-11T02:00:00Z', now)).toBe('tomorrow');
    expect(startsInWords('2026-10-19T00:00:00Z', now)).toBe('in 9 days');
    expect(startsInWords('2026-10-31T00:00:00Z', now)).toBe('in 3 weeks');
  });

  test('progress stays between nothing and all of it', () => {
    expect(progressOf('2026-10-06T00:00:00Z', '2026-10-13T00:00:00Z', at('2026-10-09T12:00:00Z'))).toBeCloseTo(0.5, 5);
    expect(progressOf('2026-10-06T00:00:00Z', '2026-10-13T00:00:00Z', at('2026-10-01T00:00:00Z'))).toBe(0);
    expect(progressOf('2026-10-06T00:00:00Z', '2026-10-13T00:00:00Z', at('2026-11-01T00:00:00Z'))).toBe(1);
    expect(progressOf('2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z', at('2026-10-06T00:00:00Z'))).toBe(0);
  });

  test('the word for a week', () => {
    expect([0, 1, 2, 11].map(weekWord)).toEqual(['This week', 'Next week', 'In 2 weeks', 'In 11 weeks']);
  });
});

describe('stretches', () => {
  test('a week without segments is one stretch of its scheduled person', () => {
    expect(allSegments(WEEKS).map((s) => [s.technicianId, s.weekIndex])).toEqual([[3, 0], [7, 0], [7, 1], [12, 2]]);
  });

  test('the stretch that holds now runs across a cover into the same person own week', () => {
    expect(currentStretch(WEEKS, at('2026-10-11T00:00:00Z'))).toEqual({
      technicianId: 7, startsAt: '2026-10-10T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z', cover: true,
    });
    expect(currentStretch(WEEKS, at('2026-10-07T00:00:00Z'))).toMatchObject({ technicianId: 3, endsAt: '2026-10-10T00:00:00.000Z', cover: false });
    expect(currentStretch(WEEKS, at('2027-01-01T00:00:00Z'))).toBeNull();
  });

  test('my turn: the one I hold now, or the next one; touching stretches are one turn', () => {
    expect(myTurn(WEEKS, 7, at('2026-10-08T00:00:00Z'))).toEqual({ startsAt: '2026-10-10T00:00:00.000Z', endsAt: '2026-10-20T00:00:00.000Z', cover: true, now: false });
    expect(myTurn(WEEKS, 7, at('2026-10-11T00:00:00Z'))).toMatchObject({ now: true, endsAt: '2026-10-20T00:00:00.000Z' });
    expect(myTurn(WEEKS, 12, at('2026-10-11T00:00:00Z'))).toEqual({ startsAt: '2026-10-20T00:00:00.000Z', endsAt: '2026-10-27T00:00:00.000Z', cover: false, now: false });
    // Mine is over: nothing left in the weeks shown.
    expect(myTurn(WEEKS, 3, at('2026-10-11T00:00:00Z'))).toBeNull();
    expect(myTurn(WEEKS, null, at('2026-10-11T00:00:00Z'))).toBeNull();
    expect(myTurn(WEEKS, 404, at('2026-10-11T00:00:00Z'))).toBeNull();
  });

  test('the next week that is a person own', () => {
    expect(nextOwnWeek(WEEKS, 12).index).toBe(2);
    expect(nextOwnWeek(WEEKS.slice(1), 3)).toBeNull();
  });
});

describe('local dates', () => {
  test('words for a date string, without a zone getting in the way', () => {
    expect(dayWords('2026-10-12')).toBe('Mon 12 Oct');
    expect(dayWords('2026-11-01')).toBe('Sun 1 Nov');
    expect(dayWords('nonsense')).toBe('');
  });

  test('the local date of an instant in the workspace zone', () => {
    // 00:30 UTC on the 11th is still the 10th in Vancouver.
    expect(localDateOf('2026-10-11T00:30:00Z', 'America/Vancouver')).toBe('2026-10-10');
    expect(localDateOf('2026-10-11T00:30:00Z', 'UTC')).toBe('2026-10-11');
    expect(localDateOf('2026-10-11T00:30:00Z', 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localDateOf('nonsense', 'UTC')).toBe('');
  });

  test('month grids start on Monday and pad both ends', () => {
    const days = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((date) => ({ date, technicianId: 3 }));
    const months = monthGrids(days);
    expect(months.map((m) => [m.key, m.label])).toEqual([['2026-10', 'October 2026'], ['2026-11', 'November 2026']]);
    // 29 Oct 2026 is a Thursday: three blanks first.
    expect(months[0].rows).toHaveLength(1);
    expect(months[0].rows[0].map((d) => d?.day ?? null)).toEqual([null, null, null, 29, 30, 31, null]);
    // 1 Nov is a Sunday (the last cell of its row), 2 Nov starts the next row.
    expect(months[1].rows.map((row) => row.map((d) => d?.day ?? null))).toEqual([[null, null, null, null, null, null, 1], [2, null, null, null, null, null, null]]);
    expect(months[1].rows[0][6]).toMatchObject({ date: '2026-11-01', technicianId: 3, weekday: 0 });
    expect(monthGrids([])).toEqual([]);
    expect(monthGrids([{ date: 'bad' }])).toEqual([]);
  });
});

describe('the calendar file', () => {
  const PEOPLE = { 3: { name: 'Andrew Fong' }, 7: { name: 'Maria Lee' }, 12: { name: 'Dana; Agent, Jr' } };
  const now = new Date('2026-10-10T12:00:00Z');

  test('my turns only: one event per turn, touching stretches merged, UTC instants', () => {
    const { text, count } = buildIcs({ weeks: WEEKS, people: PEOPLE, onlyTechnicianId: 7, now, host: 'tp.example' });
    expect(count).toBe(1);
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('UID:on-call-7-20261010T000000Z@tp.example');
    expect(text).toContain('DTSTART:20261010T000000Z');
    expect(text).toContain('DTEND:20261020T000000Z');
    expect(text).toContain('DTSTAMP:20261010T120000Z');
    expect(text).toContain('SUMMARY:On call\\, covering');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  test('the whole schedule: an event per holder, names escaped, no line over 75 characters', () => {
    const { text, count } = buildIcs({ weeks: WEEKS, people: PEOPLE, now });
    expect(count).toBe(3);
    expect(text).toContain('SUMMARY:On call: Andrew Fong');
    expect(text).toContain('SUMMARY:On call: Maria Lee (cover)');
    expect(text).toContain('SUMMARY:On call: Dana\\; Agent\\, Jr');
    for (const line of text.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
    // A folded line continues with a space, as calendars expect.
    expect(text).toMatch(/\r\n \S/);
  });

  test('somebody without a turn gets an empty calendar and a count of nothing', () => {
    const { text, count } = buildIcs({ weeks: WEEKS, people: PEOPLE, onlyTechnicianId: 404, now });
    expect(count).toBe(0);
    expect(text).not.toContain('BEGIN:VEVENT');
  });
});
