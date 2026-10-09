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

  // HR lifecycle research §4 (1 Oct 2026): formats the reader used to miss.
  test('departure date change and contract end change: the new ("to") date', () => {
    expect(readHrNoticeDate({ subject: 'Departure Notification: Sam Doe departure date has changed', text: 'Hello, The departure date has changed from 2026-05-14 to 2026-05-15 for Sam Doe in the Calgary office.' }))
      .toMatchObject({ kind: 'departure', date: '2026-05-15', reason: 'Last day moved to May 15 — offboarding (from the HR notice)' });
    expect(readHrNoticeDate({ subject: 'Departure Notification: Andy Doe departure date has changed', text: 'The departure date has changed to 2025-05-02 for Andy Doe in the Brisbane office.' }).date).toBe('2025-05-02');
    expect(readHrNoticeDate({ subject: 'Departure Notification: Lee Kay Contract End Date has changed to 2027-02-26', text: 'The contract end date has changed from 2026-10-02 to 2027-02-26 for Lee Kay.' }))
      .toMatchObject({ kind: 'departure', date: '2027-02-26', reason: 'Contract end moved to Feb 26 — offboarding (from the HR notice)' });
    expect(readHrNoticeDate({ subject: 'Departure Notification: Jo Roe will no longer be departing', text: 'Jo Roe will no longer be departing. Please make any necessary changes as required.' })).toBeNull();
  });

  test('on leave, current table format (no colons): the leave START, not the return', () => {
    const text = 'Hello, New Leave Records Employee Number Location Leave Type Expected Leave Date Expected Return Date 583 Vancouver Maternity / Parental Leave 2026-09-21 2027-10-12 Removed Leave Records Employee Number 583 2026-10-05 2027-10-12';
    expect(readHrNoticeDate({ subject: 'On Leave Notification: Vic Camp', text }))
      .toMatchObject({ kind: 'leave', date: '2026-09-21', reason: 'Leave starts Sep 21 (back Oct 12) (from the HR notice)' });
    // Old labelled format with both labels: the start wins.
    expect(readHrNoticeDate({ subject: 'On Leave Notification: Jas Singh will be going On Leave', text: 'Leave Type: Maternity / Parental Leave Expected Leave Date: 2026-11-23 Expected Return Date: 2027-02-08' }).date).toBe('2026-11-23');
  });

  test('old start-date-change order ("to Y from X") and the new-hire office change', () => {
    expect(readHrNoticeDate({ subject: 'New Hire Notification: Dev B start date has changed', text: 'The start date has changed to 2026-09-01 from 2026-08-15 for Dev B in the Toronto office.' }).date).toBe('2026-09-01');
    expect(readHrNoticeDate({ subject: 'New Hire Notification: Matt M office location has changed', text: 'The office location for Matt M has changed to Vancouver from Fredericton who is due to start on 2026-06-01.' }))
      .toMatchObject({ kind: 'start_change', date: '2026-06-01' });
  });

  test('anything else, or no clear date, is null', () => {
    expect(readHrNoticeDate({ subject: 'Transfer Notification: Quentin', text: 'Hello, please see attached' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'Equipment for office transfer', text: 'Transfer Date 2026-10-05' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'VPN broken', text: 'Start date: 2026-10-19' })).toBeNull();
    expect(readHrNoticeDate({ subject: 'Departure Notification: A', text: 'Departure Date: 2026-02-30' })).toBeNull();
  });
});

describe('hrWakeDate — lead time for HR parks (Vahid, 25 Sep 2026; new hire 21 days and departure 14 days since 8 Oct 2026)', () => {
  test('new hire / start change: 21 days before the start', () => {
    expect(hrWakeDate('new_hire', '2026-10-19')).toBe('2026-09-28');
    expect(hrWakeDate('start_change', '2027-03-01')).toBe('2027-02-08');
    expect(hrWakeDate('new_hire', '2027-01-04')).toBe('2026-12-14'); // Mon → Mon
  });

  test('a wake that lands on a weekend moves back to the Friday', () => {
    expect(hrWakeDate('new_hire', '2026-11-01')).toBe('2026-10-09'); // Sun − 21 = Sun → Fri
    expect(hrWakeDate('departure', '2026-10-11')).toBe('2026-09-25'); // Sun − 14 = Sun → Fri
  });

  test('departure: 14 days before the last day', () => {
    expect(hrWakeDate('departure', '2026-10-09')).toBe('2026-09-25'); // Fri → Fri
    expect(hrWakeDate('departure', '2026-10-16')).toBe('2026-10-02');
  });

  test('leave: still the Monday of the week of the date', () => {
    expect(hrWakeDate('leave', '2026-11-16')).toBe('2026-11-16'); // Monday return
    expect(hrWakeDate('leave', '2026-11-18')).toBe('2026-11-16'); // Wed → Mon
  });

  test('transfer: 2 business days before the effective date', () => {
    expect(hrWakeDate('transfer', '2026-10-07')).toBe('2026-10-05'); // Wed → Mon
    expect(hrWakeDate('transfer', '2026-10-05')).toBe('2026-10-01'); // Mon → Thu before
  });

  test('the business calendar decides: a holiday is skipped (Thanksgiving Mon 12 Oct 2026)', () => {
    const holidays = new Set(['2026-10-12']);
    const isBusinessDay = (iso) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5 && !holidays.has(iso); };
    expect(hrWakeDate('transfer', '2026-10-14', { isBusinessDay })).toBe('2026-10-09'); // Wed → Tue 13, (Mon 12 holiday) Fri 9
    expect(hrWakeDate('departure', '2026-10-26', { isBusinessDay })).toBe('2026-10-09'); // Mon − 14 = holiday Mon 12 → Friday before
  });

  test('other kinds keep their date', () => {
    expect(hrWakeDate('unknown', '2026-10-07')).toBe('2026-10-07');
  });
});

// 8 Oct 2026 (production audit): the park reader keeps its six-month window; the
// one-line transfer notice now has a date.
describe('audit gaps', () => {
  test('a new-hire start more than six months ahead stays unparked by the reader (parks hold six months)', () => {
    expect(readHrNoticeDate({ subject: 'New Hire: John Paul Mortin', text: 'Start Date: Mon January 18 Employee #: 2324', createdAt: '2026-05-12T17:00:00Z' })).toBeNull();
  });
  test('one-line transfer notice', () => {
    expect(readHrNoticeDate({
      subject: 'Transfer Notification: Devin Frioud will be transferring from Vancouver office to Victoria office',
      text: 'Hello, Devin Frioud will be transferring from Vancouver office to Victoria office on 2026-07-06. Please make any necessary changes required.',
      createdAt: '2025-11-14T17:00:00Z',
    })).toMatchObject({ kind: 'transfer', date: '2026-07-06' });
  });
});
