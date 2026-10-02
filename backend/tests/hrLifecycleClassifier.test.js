import { classifyHrNotice, normalizePersonName, stripSecrets, DETECTION_RULES, NOTICE_EFFECT } from '../src/utils/hrNoticeClassifier.js';

/**
 * Onboarding / Offboarding classifier (plans/HR_LIFECYCLE_PLAN.md). Every case
 * is a redacted, realistic notice from plans/HR_LIFECYCLE_RESEARCH.md §1–2
 * (names and ids changed).
 */
const HR = 'humanresources@bgcengineering.ca';
const BAMBOO = 'notifications@app.bamboohr.com';
const created = '2026-09-25T17:00:00Z'; // Thu 25 Sep, 10:00 Pacific
const PROFILE = 'To view more information please click Bamboo Profile : https://bgcengineering.bamboohr.com/employees/employee.php?id=1234&page=2096';
const FOOTER = 'This e-mail may contain confidential information. Please see our privacy policy.';
const classify = (subject, text, requesterEmail = HR) => classifyHrNotice({ subject, text, requesterEmail, createdAt: created });

describe('classifyHrNotice — departures', () => {
  test('new departure notice: name, office, last day and the BambooHR id', () => {
    const c = classify('Departure Notification: Jamie Gill from the Calgary office will be departing', `Hello, Name: Jamie Gill Office: Calgary Departure Date: 2026-10-02 ${PROFILE} ${FOOTER}`);
    expect(c).toMatchObject({ type: 'departure', person: 'Jamie Gill', office: 'Calgary', date: '2026-10-02', employeeId: '1234', effectiveImmediately: false, noticeDate: '2026-09-25' });
  });

  test('office strings with a team suffix and the "Copy of" re-send', () => {
    const c = classify('Copy of Departure Notification: Alex Dula from the Vancouver - Software office will be departing', 'Name: Alex Dula Office: Vancouver - Software Departure Date: 2026-10-09');
    expect(c).toMatchObject({ type: 'departure', person: 'Alex Dula', office: 'Vancouver - Software', date: '2026-10-09' });
  });

  test('"effective immediately" is flagged', () => {
    const c = classify('Departure Notification: Pat Lee from the Halifax office will be departing', 'Name: Pat Lee Office: HFX Departure Date: 2026-09-30 This departure is effective immediately.');
    expect(c.effectiveImmediately).toBe(true);
  });

  test('departure date changed (new and old wording) → the new date', () => {
    expect(classify('Departure Notification: Sav Logan departure date has changed', 'Hello, The departure date has changed from 2026-05-14 to 2026-05-15 for Sav Logan in the Calgary office.'))
      .toMatchObject({ type: 'departure_date_change', person: 'Sav Logan', date: '2026-05-15', fromDate: '2026-05-14', office: 'Calgary' });
    expect(classify('Departure Notification: Andy Doe departure date has changed', 'The departure date has changed to 2025-05-02 for Andy Doe in the Brisbane office.'))
      .toMatchObject({ type: 'departure_date_change', date: '2025-05-02', fromDate: null });
  });

  test('contract end changed → moves the departure out', () => {
    expect(classify('Departure Notification: Lia Kas Contract End Date has changed to 2027-02-26', 'The contract end date has changed from 2026-10-02 to 2027-02-26 for Lia Kas.'))
      .toMatchObject({ type: 'contract_end_change', person: 'Lia Kas', date: '2027-02-26', fromDate: '2026-10-02' });
  });

  test('cancellation', () => {
    expect(classify('Departure Notification: Julie Tay will no longer be departing', 'Julie Tay will no longer be departing. Please make any necessary changes as required.'))
      .toMatchObject({ type: 'departure_cancelled', person: 'Julie Tay', date: null });
  });
});

describe('classifyHrNotice — new hires', () => {
  test('BambooHR "New Hire" with a year-less start date, employee #, title, office and manager', () => {
    const c = classify('New Hire: Teddi Hern', 'New Hire: Teddi Hern New Team Member Start Date: Mon October 05 Employee #: 2374 Position: Geoscientist-in-Training Employee Status: PTR - Part-time Regular Department: Engineering/Geoscience Division: Intermediate I Location: Calgary Reports To: Maria Cruz View Employee Record', BAMBOO);
    expect(c).toMatchObject({ type: 'new_hire', person: 'Teddi Hern', date: '2026-10-05', employeeId: '2374', title: 'Geoscientist-in-Training', office: 'Calgary', manager: 'Maria Cruz' });
  });

  test('old BambooHR format with the year, and the dated subject variant', () => {
    expect(classify('New Hire Oct 6: Rae Moss', 'Start Date: Monday, October 06, 2026 Employee #: 2400 Position: Engineer Employee Status: FTR Location: Toronto Reports To: Kim Lee', BAMBOO))
      .toMatchObject({ type: 'new_hire', person: 'Rae Moss', date: '2026-10-06', employeeId: '2400' });
  });

  test('start date changed — both from/to orders', () => {
    expect(classify('New Hire Notification: Dev Babb start date has changed', 'The start date has changed from 2026-07-20 to 2027-03-01 for Dev Babb in the Toronto office.'))
      .toMatchObject({ type: 'start_date_change', date: '2027-03-01', fromDate: '2026-07-20' });
    expect(classify('New Hire Notification: Dev Babb start date has changed', 'The start date has changed to 2026-09-01 from 2026-08-15 for Dev Babb in the Toronto office.'))
      .toMatchObject({ type: 'start_date_change', date: '2026-09-01', fromDate: '2026-08-15' });
  });

  test('office location changed and cancellation', () => {
    expect(classify('New Hire Notification: Matt Mill office location has changed', 'The office location for Matt Mill has changed to Vancouver from Fredericton who is due to start on 2026-06-01.'))
      .toMatchObject({ type: 'new_hire_office_change', person: 'Matt Mill', office: 'Vancouver', fromOffice: 'Fredericton', date: '2026-06-01' });
    expect(classify('New Hire Notification: Bill Medd will no longer be starting', 'Bill Medd will no longer be starting on 2026-05-04.'))
      .toMatchObject({ type: 'new_hire_cancelled', person: 'Bill Medd' });
  });

  test('NH automation ticket: any sender, employee id from the body, never the password', () => {
    const c = classify('NH Laptop - Brisbane - AU - jdoe - 2026-10-12', 'Please set up a laptop for the new user: Start Date: 2026-10-12 Username: jdoe Full Name: Jane Doe ID: 2249 Email: jdoe@bgcengineering.ca Password: Tr0ub4dor&3 Location: Brisbane - AU Labour Class: Principal', 'jdoe@bgcengineering.ca');
    expect(c).toMatchObject({ type: 'nh_automation', nhKind: 'laptop', office: 'Brisbane', username: 'jdoe', date: '2026-10-12', employeeId: '2249', person: 'Jane Doe' });
    expect(JSON.stringify(c)).not.toContain('Tr0ub4dor');
    expect(classify('NH Workstation - Montreal - CA - rmoss - 2026-11-10', 'Monitors - 2 User Information: Start Date: 2026-11-10 Username: rmoss Full Name: Rae Moss ID: 2400 Email: x', 'ticketpulse@bgcengineering.ca'))
      .toMatchObject({ type: 'nh_automation', nhKind: 'workstation', employeeId: '2400' });
  });
});

describe('classifyHrNotice — leave and transfer', () => {
  test('current leave table: leave start + return + employee number', () => {
    const c = classify('On Leave Notification: Vic Camp', 'Hello, New Leave Records Employee Number Location Leave Type Expected Leave Date Expected Return Date 583 Vancouver Maternity / Parental Leave 2026-10-21 2027-10-12 Removed Leave Records Employee Number Location 583 2026-10-05 2027-10-12');
    expect(c).toMatchObject({ type: 'leave', person: 'Vic Camp', date: '2026-10-21', leaveStart: '2026-10-21', returnDate: '2027-10-12', employeeId: '583' });
  });

  test('old leave formats and the date-changed subjects', () => {
    expect(classify('On Leave Notification: Jas Singh will be going On Leave', 'Leave Type: Maternity / Parental Leave Expected Leave Date: 2026-11-23 Expected Return Date: 2027-02-08'))
      .toMatchObject({ type: 'leave', person: 'Jas Singh', date: '2026-11-23', returnDate: '2027-02-08', leaveType: 'Maternity / Parental Leave' });
    expect(classify('On Leave Notification: Sara Ata expected return date has changed to 2026-08-31 in Vancouver', ''))
      .toMatchObject({ type: 'leave_change', changed: 'return', date: '2026-08-31', office: 'Vancouver' });
  });

  test('transfer: the table date and the old subject wording', () => {
    expect(classify('Transfer Notification: Sara Ata', 'New Transfer Records Employee Number Current Location Transfer Date Transfer From Office Transfer To Office Comments 1811 Vancouver 2026-10-05 Vancouver Surrey N/A Removed Transfer Records'))
      .toMatchObject({ type: 'transfer', person: 'Sara Ata', date: '2026-10-05', employeeId: '1811' });
    expect(classify('Transfer Notification: Aly Sand will be transferring from Calgary office to Edmonton office', 'Transfer Date: 2026-11-02'))
      .toMatchObject({ type: 'transfer', person: 'Aly Sand', fromOffice: 'Calgary', office: 'Edmonton', date: '2026-11-02' });
  });
});

describe('classifyHrNotice — what is NOT a notice', () => {
  test('our own children, replies, other senders and ordinary tickets are null', () => {
    expect(classify('Child Ticket - Laptop - Departure Notification: Jamie Gill from the Calgary office will be departing', 'x')).toBeNull();
    expect(classify('RE: New Hire: Teddi Hern', 'thanks', BAMBOO)).toBeNull();
    expect(classify('Departure Notification: Test Sam from the Calgary office will be departing', 'Name: Test', 'someone@bgcengineering.ca')).toBeNull();
    expect(classify('New Hire: Ann Bee', 'x', 'billing@bamboohr.com')).toBeNull();
    expect(classify('VPN broken', 'Departure Date: 2026-10-02')).toBeNull();
    expect(classify('Employment Status Change', 'x')).toBeNull();
  });

  test('every rule has a matching effect (no orphan types)', () => {
    for (const r of DETECTION_RULES) expect(NOTICE_EFFECT[r.type]).toBeTruthy();
  });
});

describe('stripSecrets — never copy an initial password', () => {
  test('flattened NH body: the password field goes, the rest stays', () => {
    const out = stripSecrets('Username: jdoe Full Name: Jane Doe ID: 2249 Email: jdoe@x.ca Password: Hunter2!x Location: Brisbane - AU');
    expect(out).not.toMatch(/hunter2/i);
    expect(out).not.toMatch(/password/i);
    expect(out).toContain('Location: Brisbane - AU');
    expect(out).toContain('ID: 2249');
  });

  test('label on its own line, temporary passwords and passcodes', () => {
    const out = stripSecrets('Hello\nPassword:\nSecr3t-Value\nTemporary password - Zz9!q\nInitial Passcode: 4455\nThanks');
    expect(out).toBe('Hello\nThanks');
  });

  test('text without a password is unchanged', () => {
    expect(stripSecrets('Name: Jamie\nOffice: Calgary')).toBe('Name: Jamie\nOffice: Calgary');
  });
});

test('normalizePersonName folds case, accents and spacing', () => {
  expect(normalizePersonName('  Michèle   OSTIGUY ')).toBe('michele ostiguy');
});
