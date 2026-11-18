import {
  formatUtcOffset, placeOfZone, resolveRequesterTimezone, utcOffsetMinutes,
} from '../src/services/assignmentTimezoneFit/requesterTimezone.js';

// QA 11-17 item 1: the requester's time zone, from what the directory says.
const NOV = new Date('2026-11-17T13:14:00Z'); // 5:14 AM PT

describe('resolveRequesterTimezone', () => {
  test('Entra city wins over the FreshService default', () => {
    expect(resolveRequesterTimezone({ entraCity: 'Santiago', entraCountry: 'Chile', timeZone: 'Pacific Time (US & Canada)' }))
      .toEqual({ timezone: 'America/Santiago', source: 'entra_city', confidence: 'high', place: 'Santiago' });
  });

  test.each([
    ['Vancouver', 'America/Vancouver'], ['Calgary', 'America/Edmonton'], ['Edmonton', 'America/Edmonton'],
    ['Fredericton', 'America/Moncton'], ['Kamloops', 'America/Vancouver'], ['Toronto', 'America/Toronto'],
    ['Halifax', 'America/Halifax'], ['Montréal', 'America/Toronto'], ['Ottawa', 'America/Toronto'],
    ['Victoria', 'America/Vancouver'], ['Santo Domingo', 'America/Santo_Domingo'], ['Surrey', 'America/Vancouver'],
    ['Kingston', 'America/Toronto'], ['Brisbane', 'Australia/Brisbane'], ['Kelowna', 'America/Vancouver'],
    ['Quebec City', 'America/Toronto'], ['Golden', 'America/Edmonton'], ['Colorado', 'America/Denver'],
    ['Nashville', 'America/Chicago'], ['Sudbury', 'America/Toronto'], ['Whitehorse', 'America/Whitehorse'],
    ['Portland', 'America/Los_Angeles'], ['Virginia', 'America/New_York'],
  ])('city %s → %s', (city, tz) => {
    expect(resolveRequesterTimezone({ entraCity: city })).toMatchObject({ timezone: tz, source: 'entra_city', confidence: 'high' });
  });

  test('a city that exists twice follows its country', () => {
    expect(resolveRequesterTimezone({ entraCity: 'London', entraCountry: 'United Kingdom' }).timezone).toBe('Europe/London');
    expect(resolveRequesterTimezone({ entraCity: 'London', entraCountry: 'Canada' }).timezone).toBe('America/Toronto');
    expect(resolveRequesterTimezone({ entraCity: 'Santiago', entraCountry: 'Dominican Republic' }).timezone).toBe('America/Santo_Domingo');
  });

  test('Washington and Montrose alone are not guessed; the state decides', () => {
    expect(resolveRequesterTimezone({ entraCity: 'Washington', entraCountry: 'United States', entraState: 'WA' }))
      .toMatchObject({ timezone: 'America/Los_Angeles', source: 'entra_state', confidence: 'medium' });
    expect(resolveRequesterTimezone({ entraCity: 'Washington', entraCountry: 'United States', entraState: 'District of Columbia' }).timezone)
      .toBe('America/New_York');
    expect(resolveRequesterTimezone({ entraCity: 'Montrose' })).toBeNull();
  });

  test('a known city inside the office location', () => {
    expect(resolveRequesterTimezone({ entraOfficeLocation: 'Calgary Office - 5th Ave' }))
      .toMatchObject({ timezone: 'America/Edmonton', source: 'entra_office', place: 'Calgary' });
  });

  test('no city: a one-zone country answers', () => {
    expect(resolveRequesterTimezone({ entraCountry: 'Chile' })).toMatchObject({ timezone: 'America/Santiago', source: 'entra_country', confidence: 'medium' });
    expect(resolveRequesterTimezone({ entraCountry: 'Dominican Republic' }).timezone).toBe('America/Santo_Domingo');
    expect(resolveRequesterTimezone({ entraCountry: 'United Kingdom' }).timezone).toBe('Europe/London');
    expect(resolveRequesterTimezone({ entraCountry: 'Canada' })).toBeNull();
  });

  test('FreshService zone names, with Pacific only as a weak last resort', () => {
    expect(resolveRequesterTimezone({ timeZone: 'Santiago' })).toMatchObject({ timezone: 'America/Santiago', source: 'freshservice', confidence: 'medium' });
    expect(resolveRequesterTimezone({ timeZone: 'Brisbane' }).timezone).toBe('Australia/Brisbane');
    expect(resolveRequesterTimezone({ timeZone: 'Atlantic Time (Canada)' }).timezone).toBe('America/Halifax');
    expect(resolveRequesterTimezone({ timeZone: 'Eastern Time (US & Canada)' }).timezone).toBe('America/Toronto');
    expect(resolveRequesterTimezone({ timeZone: 'Central Time (US & Canada)' }).timezone).toBe('America/Winnipeg');
    expect(resolveRequesterTimezone({ timeZone: 'Mountain Time (US & Canada)' }).timezone).toBe('America/Edmonton');
    expect(resolveRequesterTimezone({ timeZone: 'Pacific Time (US & Canada)' }))
      .toMatchObject({ timezone: 'America/Vancouver', source: 'freshservice_default', confidence: 'low' });
    expect(resolveRequesterTimezone({ timeZone: 'American Samoa' })).toBeNull();
  });

  test('nothing to go on', () => {
    expect(resolveRequesterTimezone(null)).toBeNull();
    expect(resolveRequesterTimezone({})).toBeNull();
  });
});

describe('offsets', () => {
  test('November offsets', () => {
    expect(utcOffsetMinutes('America/Santiago', NOV)).toBe(-180);
    expect(utcOffsetMinutes('America/Toronto', NOV)).toBe(-300);
    expect(utcOffsetMinutes('America/Edmonton', NOV)).toBe(-420);
    expect(utcOffsetMinutes('America/Vancouver', NOV)).toBe(-480);
    expect(utcOffsetMinutes('Europe/London', NOV)).toBe(0);
    expect(utcOffsetMinutes('America/St_Johns', NOV)).toBe(-210);
    expect(utcOffsetMinutes('Not/AZone', NOV)).toBeNull();
  });

  test('formatting', () => {
    expect(formatUtcOffset(-180)).toBe('UTC−3');
    expect(formatUtcOffset(600)).toBe('UTC+10');
    expect(formatUtcOffset(-210)).toBe('UTC−3:30');
    expect(formatUtcOffset(0)).toBe('UTC');
    expect(placeOfZone('America/Santo_Domingo')).toBe('Santo Domingo');
  });
});
