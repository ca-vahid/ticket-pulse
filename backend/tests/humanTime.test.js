import { formatHumanTime, isIsoTimestamp } from '../src/utils/humanTime.js';

describe('humanTime (QA 11-02 #2)', () => {
  test('recognises whole ISO timestamps only', () => {
    expect(isIsoTimestamp('2026-10-28T19:34:41.799Z')).toBe(true);
    expect(isIsoTimestamp('2026-10-28T19:34:41-07:00')).toBe(true);
    expect(isIsoTimestamp('2026-10-28')).toBe(false);
    expect(isIsoTimestamp('Received 2026-10-28T19:34:41.799Z')).toBe(false);
    expect(isIsoTimestamp(42)).toBe(false);
  });

  test('BC prints as PT', () => {
    expect(formatHumanTime('2026-10-28T19:34:41.799Z', 'America/Vancouver')).toBe('Wed 28 Oct 2026, 12:34 PM PT');
  });

  // After 1 Nov 2026 only tzdata 2026b+ knows BC stayed on UTC-7 (production
  // loads 2026e; an older local Node still falls back an hour).
  const knowsPermanentBc = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hour12: false })
    .format(new Date('2026-11-16T16:00:00.000Z'))) === 9;
  (knowsPermanentBc ? test : test.skip)('BC stays on UTC-7 after 1 Nov 2026', () => {
    expect(formatHumanTime('2026-11-16T16:00:00.000Z', 'America/Vancouver')).toBe('Mon 16 Nov 2026, 9:00 AM PT');
  });

  test('other zones, Date objects, a bad zone and non-times', () => {
    expect(formatHumanTime(new Date('2026-10-28T19:34:41.799Z'), 'America/Halifax')).toBe('Wed 28 Oct 2026, 4:34 PM AT');
    expect(formatHumanTime('2026-10-28T19:34:41.799Z', 'Not/AZone')).toBe('Wed 28 Oct 2026, 12:34 PM PT');
    expect(formatHumanTime('hello', 'America/Vancouver')).toBeNull();
  });
});
