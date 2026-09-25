import { readHrNoticeDate, hrWakeDate } from '../src/utils/hrNoticeDates.js';

/**
 * Parked §2.6: strict HR-notice date reader. Every case is a real notice
 * format from the 52 open IT notices measured on 23 Sep 2026.
 */
describe('readHrNoticeDate', () => {
  const created = new Date('2026-09-20T12:00:00Z');

  test('transfer: the Transfer Date in the NEW records, not the removed ones', () => {
    const text = 'Hello, Transfer changes for Laura Beamish . New Transfer Records Employee Number Current Location Transfer Date Transfer From Office Transfer To Office Comments 320 Vancouver 2026-10-05 Vancouver Edmonton N/A Removed Transfer Records Employee Number Current Location Transfer Date 2026-01-02';
    expect(readHrNoticeDate({ subject: 'Transfer Notification: Laura Beamish', text, createdAt: created }))
      .toEqual({ kind: 'transfer', date: '2026-10-05', reason: 'Transfer effective Oct 5 (from the HR notice)', source: 'hr_notice' });
  });

  test('departure, on leave, NH laptop, start-date change', () => {
    expect(readHrNoticeDate({ subject: 'Departure Notification: Zak Semeniuk from the Calgary office', text: 'Departure Date: 2026-10-09 Office: Calgary' }).date).toBe('2026-10-09');
    expect(readHrNoticeDate({ subject: 'On Leave Notification: Michèle Ostiguy will be going On Leave', text: 'Expected Return Date: 2026-11-16' }))
      .toMatchObject({ kind: 'leave', date: '2026-11-16', reason: 'On leave until Nov 16 (from the HR notice)' });
    expect(readHrNoticeDate({ subject: 'NH Laptop - Tennessee - US - CHan - 2026-10-19', text: 'Start date: 2026-10-19 Username: CHan' }).date).toBe('2026-10-19');
    expect(readHrNoticeDate({ subject: 'New Hire Notification: Devansh Babla start date has changed', text: 'Hello, The start date has changed from 2026-07-20 to 2027-03-01 for Devansh Babla' }).date).toBe('2027-03-01');
  });

  test('BambooHR new hire with no year: the weekday fixes the year', () => {
    expect(readHrNoticeDate({ subject: 'New Hire: Asif Qureshi', text: 'New Team Member Start Date: Tue October 13 Asif Qureshi View Employee Record', createdAt: created }).date).toBe('2026-10-13');
    // Wrong weekday for every nearby year → not clear → null (never guess).
    expect(readHrNoticeDate({ subject: 'New Hire: X', text: 'Start Date: Mon October 13', createdAt: created })).toBeNull();
  });

  test('anything else, or no clear date, is null', () => {
    expect(readHrNoticeDate({ subject: 'Transfer Notification: Quentin', text: 'Hello, please see attached' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'Equipment for office transfer', text: 'Transfer Date 2026-10-05' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'VPN broken', text: 'Start date: 2026-10-19' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'Departure Notification: A', text: 'Departure Date: 2026-02-30' })).toBeNull();
  });
});

describe('hrWakeDate — lead time for HR parks (Vahid, 25 Sep 2026)', () => {
  test('new hire / start change: 14 days before the start (Marcus moved #38822 Oct 19 → Oct 5)', () => {
    expect(hrWakeDate('new_hire', '2026-10-19')).toBe('2026-10-05');
    expect(hrWakeDate('start_change', '2027-03-01')).toBe('2027-02-15');
  });

  test('14 days before a start that lands on a weekend moves back to the Friday', () => {
    expect(hrWakeDate('new_hire', '2027-01-04')).toBe('2026-12-21'); // Mon → Mon
    expect(hrWakeDate('new_hire', '2026-11-01')).toBe('2026-10-16'); // Sun − 14 = Sun → Fri
  });

  test('departure and leave: the Monday of the week of the date', () => {
    expect(hrWakeDate('departure', '2026-10-09')).toBe('2026-10-05'); // Fri → Mon
    expect(hrWakeDate('departure', '2026-10-05')).toBe('2026-10-05'); // already Monday
    expect(hrWakeDate('leave', '2026-11-16')).toBe('2026-11-16'); // Monday return
    expect(hrWakeDate('leave', '2026-11-18')).toBe('2026-11-16'); // Wed → Mon
    expect(hrWakeDate('departure', '2026-10-11')).toBe('2026-10-05'); // Sun belongs to the week starting Mon 5th
  });

  test('transfer: 2 business days before the effective date', () => {
    expect(hrWakeDate('transfer', '2026-10-07')).toBe('2026-10-05'); // Wed → Mon
    expect(hrWakeDate('transfer', '2026-10-05')).toBe('2026-10-01'); // Mon → Thu before
  });

  test('the business calendar decides: a holiday is skipped (Thanksgiving Mon 12 Oct 2026)', () => {
    const isBusinessDay = (iso) => {
      const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
      return d >= 1 && d <= 5 && iso !== '2026-10-12';
    };
    expect(hrWakeDate('transfer', '2026-10-14', { isBusinessDay })).toBe('2026-10-09'); // Wed → Tue 13, (Mon 12 holiday) Fri 9
    expect(hrWakeDate('departure', '2026-10-16', { isBusinessDay })).toBe('2026-10-09'); // Monday 12 is a holiday → Friday before
  });

  test('other kinds keep their date', () => {
    expect(hrWakeDate('unknown', '2026-10-07')).toBe('2026-10-07');
  });
});
