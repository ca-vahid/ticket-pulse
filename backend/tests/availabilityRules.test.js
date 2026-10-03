import {
  decide, workingDates, requestSize, holidayMatcher, weekKey, ruleApplies, evaluateCondition,
  entitlementFor, leaveYearOf, leaveYearRange, toDay,
} from '../src/services/availability/availabilityRules.js';

// Availability (plans/AVAILABILITY_TRACKER_PLAN.md, 3 Oct 2026): the pure
// rules engine — every decision explainable, no database, no LLM.

const WFH = { id: 3, name: 'Working from home', requiresApproval: false };
const VAC = { id: 1, name: 'Vacation', requiresApproval: true };
const person = { email: 'ana@bgc.ca', officeId: 7 };
const baseCtx = (over = {}) => ({
  today: toDay('2026-10-05'),
  startDate: toDay('2026-10-14'),
  endDate: toDay('2026-10-14'),
  dates: ['2026-10-14'],
  days: 1,
  capacity: () => [],
  remaining: null,
  ...over,
});

describe('working days', () => {
  test('weekends and company holidays are skipped', () => {
    const isHoliday = holidayMatcher([{ date: '2026-10-12', isRecurring: false }]); // Thanksgiving
    expect(workingDates({ startDate: '2026-10-09', endDate: '2026-10-14', isHoliday }))
      .toEqual(['2026-10-09', '2026-10-13', '2026-10-14']);
  });
  test('recurring holidays match any year; disabled ones are ignored', () => {
    const isHoliday = holidayMatcher([{ date: '2020-12-25', isRecurring: true }, { date: '2026-12-28', isEnabled: false }]);
    expect(isHoliday(toDay('2026-12-25'))).toBe(true);
    expect(isHoliday(toDay('2026-12-28'))).toBe(false);
  });
  test('custom work week (Tue–Fri)', () => {
    expect(workingDates({ startDate: '2026-10-05', endDate: '2026-10-11', workdays: [2, 3, 4, 5] })).toHaveLength(4);
  });
  test('size: half days and hours', () => {
    expect(requestSize({ dates: ['a'], dayPart: 'am' })).toEqual({ days: 0.5, hours: 4 });
    expect(requestSize({ dates: ['a', 'b'], dayPart: 'full', dailyHours: 7.5 })).toEqual({ days: 2, hours: 15 });
    expect(requestSize({ dates: ['a'], dayPart: 'hours', startMinute: 540, endMinute: 660 })).toEqual({ days: 0.25, hours: 2 });
  });
  test('weekKey is the Monday', () => {
    expect(weekKey('2026-10-08')).toBe('2026-10-05');
    expect(weekKey('2026-10-11')).toBe('2026-10-05');
  });
});

describe('rule scope', () => {
  test('company / office / group / person and leave-type filters', () => {
    expect(ruleApplies({ scopeType: 'company' }, { person, leaveTypeId: 3 })).toBe(true);
    expect(ruleApplies({ scopeType: 'office', scopeRef: '7' }, { person, leaveTypeId: 3 })).toBe(true);
    expect(ruleApplies({ scopeType: 'office', scopeRef: '8' }, { person, leaveTypeId: 3 })).toBe(false);
    expect(ruleApplies({ scopeType: 'group', scopeRef: '2' }, { person, leaveTypeId: 3, groupIds: [2] })).toBe(true);
    expect(ruleApplies({ scopeType: 'person', scopeRef: 'ANA@bgc.ca' }, { person, leaveTypeId: 3 })).toBe(true);
    expect(ruleApplies({ scopeType: 'company', leaveTypeIds: [1] }, { person, leaveTypeId: 3 })).toBe(false);
    expect(ruleApplies({ scopeType: 'company', isActive: false }, { person, leaveTypeId: 3 })).toBe(false);
  });
});

describe("Vahid's examples", () => {
  const capRule = { id: 10, name: 'Vancouver WFH cap', scopeType: 'office', scopeRef: '7', leaveTypeIds: [3], condition: { kind: 'capacity', window: 'week', max: 3, scope: 'office' }, outcome: 'needs_approval' };
  const aheadRule = { id: 11, name: 'WFH booking window', scopeType: 'company', leaveTypeIds: [3], condition: { kind: 'advance_notice', maxDaysAhead: 28 }, outcome: 'refuse', message: 'WFH can be booked at most 4 weeks ahead.' };

  test('Vancouver: 3 others already WFH that week → needs approval, with the count in the reason', () => {
    const v = decide({ rules: [capRule], leaveType: WFH, person, ctx: baseCtx({ capacity: () => [{ window: '2026-10-12', others: 3 }] }) });
    expect(v.outcome).toBe('pending');
    expect(v.reason).toMatch(/3 others are already booked in your office in the week of 2026-10-12 \(limit 3\)/);
  });
  test('Vancouver: 2 others → auto-approved (WFH needs no approval)', () => {
    const v = decide({ rules: [capRule], leaveType: WFH, person, ctx: baseCtx({ capacity: () => [{ window: '2026-10-12', others: 2 }] }) });
    expect(v.outcome).toBe('approved');
    expect(v.fired).toEqual([]);
  });
  test('WFH more than 4 weeks ahead is refused with the message', () => {
    const v = decide({ rules: [aheadRule, capRule], leaveType: WFH, person, ctx: baseCtx({ startDate: toDay('2026-11-20'), endDate: toDay('2026-11-20') }) });
    expect(v.outcome).toBe('refused');
    expect(v.reason).toMatch(/at most 4 weeks ahead\. It starts 46 days from now/);
  });
  test('vacation always needs approval; site visit (no approval) is auto-approved', () => {
    expect(decide({ rules: [], leaveType: VAC, person, ctx: baseCtx() }).outcome).toBe('pending');
    expect(decide({ rules: [], leaveType: { id: 4, name: 'Site visit', requiresApproval: false }, person, ctx: baseCtx() }).outcome).toBe('approved');
  });
  test('an approval group that auto-approves vacation approves it, unless a rule asks for approval', () => {
    expect(decide({ rules: [], leaveType: VAC, person, groupAutoApprove: true, ctx: baseCtx() }).outcome).toBe('approved');
    const long = { id: 12, name: 'Long vacation', condition: { kind: 'duration', maxDays: 5 }, outcome: 'needs_approval' };
    const v = decide({ rules: [long], leaveType: VAC, person, groupAutoApprove: true, ctx: baseCtx({ days: 8 }) });
    expect(v.outcome).toBe('pending');
    expect(v.reason).toMatch(/8 working days; the limit is 5/);
  });
});

describe('conditions', () => {
  test('refuse beats needs_approval beats auto_approve; warn never decides', () => {
    const r = (id, outcome) => ({ id, name: `r${id}`, condition: { kind: 'always' }, outcome, priority: id });
    expect(decide({ rules: [r(1, 'warn'), r(2, 'auto_approve')], leaveType: VAC, person, ctx: baseCtx() }).outcome).toBe('approved');
    expect(decide({ rules: [r(1, 'auto_approve'), r(2, 'needs_approval')], leaveType: WFH, person, ctx: baseCtx() }).outcome).toBe('pending');
    const v = decide({ rules: [r(1, 'warn'), r(2, 'needs_approval'), r(3, 'refuse')], leaveType: WFH, person, ctx: baseCtx() });
    expect(v.outcome).toBe('refused');
    expect(v.warnings).toHaveLength(1);
  });
  test('minimum notice, blackout, balance, past-dated', () => {
    const ctx = baseCtx();
    expect(evaluateCondition({ condition: { kind: 'advance_notice', minDaysAhead: 14 } }, ctx).match).toBe(true);
    expect(evaluateCondition({ condition: { kind: 'advance_notice', minDaysAhead: 7 } }, ctx).match).toBe(false);
    expect(evaluateCondition({ condition: { kind: 'blackout', from: '2026-10-13', to: '2026-10-20', label: 'Year-end close' } }, ctx).detail).toMatch(/Year-end close/);
    expect(evaluateCondition({ condition: { kind: 'balance' } }, baseCtx({ remaining: 0.5, days: 1 })).match).toBe(true);
    expect(evaluateCondition({ condition: { kind: 'balance', allowNegativeDays: 1 } }, baseCtx({ remaining: 0.5, days: 1 })).match).toBe(false);
    expect(evaluateCondition({ condition: { kind: 'balance' } }, baseCtx({ remaining: null })).match).toBe(false);
    expect(evaluateCondition({ condition: { kind: 'past_dated' } }, baseCtx({ startDate: toDay('2026-10-01') })).match).toBe(true);
  });
});

describe('entitlement', () => {
  const policy = { annualDays: 10, tenureTiers: [{ afterYears: 5, days: 15 }], prorate: true };
  test('tenure tier from completed years at the year start', () => {
    expect(entitlementFor(policy, { startDate: '2020-03-01', year: 2026 })).toBe(15);
    expect(entitlementFor(policy, { startDate: '2021-06-01', year: 2026 })).toBe(10); // 4 full years on 1 Jan 2026
  });
  test('a mid-year starter is pro-rated to the nearest half day', () => {
    expect(entitlementFor(policy, { startDate: '2026-07-01', year: 2026 })).toBe(5);
  });
  test('sick days only after 90 days of employment', () => {
    const sick = { annualDays: 5, eligibleAfterDays: 90 };
    expect(entitlementFor(sick, { startDate: '2026-11-01', year: 2026 })).toBe(0);
    expect(entitlementFor(sick, { startDate: '2026-01-05', year: 2026 })).toBe(5);
  });
  test('fiscal year starting in April', () => {
    expect(leaveYearOf('2027-02-10', 4)).toBe(2026);
    expect(leaveYearRange(2026, 4).end.toISOString().slice(0, 10)).toBe('2027-03-31');
  });
});

// 3 Oct 2026 (Vahid): WFH this week and next only; 1 WFH day per week;
// Vancouver 3 a day, every other office 1 a day.
describe('WFH rules, 3 Oct 2026', () => {
  const window = { id: 20, name: 'WFH window', condition: { kind: 'booking_window', weeksAhead: 1 }, outcome: 'refuse' };
  const perWeek = { id: 21, name: 'WFH 1 day a week', condition: { kind: 'per_person', window: 'week', maxDays: 1 }, outcome: 'needs_approval' };
  const cap = { id: 22, name: 'WFH office cap', condition: { kind: 'capacity', window: 'day', max: 1, scope: 'office', officeMax: { 7: 3 } }, outcome: 'needs_approval' };
  // today = Mon 5 Oct 2026; this week ends Sun 11 Oct, next week Sun 18 Oct
  const at = (d, over = {}) => baseCtx({ today: toDay('2026-10-05'), startDate: toDay(d), endDate: toDay(d), dates: [d], ...over });

  test('booking window: next Friday is fine, the week after is refused', () => {
    expect(decide({ rules: [window], leaveType: WFH, person, ctx: at('2026-10-16') }).outcome).toBe('approved');
    const v = decide({ rules: [window], leaveType: WFH, person, ctx: at('2026-10-19') });
    expect(v.outcome).toBe('refused');
    expect(v.reason).toMatch(/this week and next only \(up to 2026-10-18\)/);
  });
  test('weeksAhead 0 = this week only', () => {
    const v = decide({ rules: [{ ...window, condition: { kind: 'booking_window', weeksAhead: 0 } }], leaveType: WFH, person, ctx: at('2026-10-12') });
    expect(v.reason).toMatch(/this week only/);
  });
  test('1 day per week: a second WFH day that week needs approval', () => {
    const second = decide({ rules: [perWeek], leaveType: WFH, person, ctx: at('2026-10-08', { ownUsage: () => [{ window: '2026-10-05', used: 1, adding: 1 }] }) });
    expect(second.outcome).toBe('pending');
    expect(second.reason).toMatch(/limit is 1 day per week\. You already have 1 day booked in the week of 2026-10-05/);
    const first = decide({ rules: [perWeek], leaveType: WFH, person, ctx: at('2026-10-08', { ownUsage: () => [{ window: '2026-10-05', used: 0, adding: 1 }] }) });
    expect(first.outcome).toBe('approved');
  });
  test('Vancouver allows 3 a day; any other office 1', () => {
    const van = { ...person, officeId: 7 };
    const cal = { ...person, officeId: 9 };
    const two = () => [{ window: '2026-10-08', others: 2 }];
    const one = () => [{ window: '2026-10-08', others: 1 }];
    expect(decide({ rules: [cap], leaveType: WFH, person: van, ctx: at('2026-10-08', { person: van, capacity: two }) }).outcome).toBe('approved');
    expect(decide({ rules: [cap], leaveType: WFH, person: van, ctx: at('2026-10-08', { person: van, capacity: () => [{ window: '2026-10-08', others: 3 }] }) }).outcome).toBe('pending');
    const calgary = decide({ rules: [cap], leaveType: WFH, person: cal, ctx: at('2026-10-08', { person: cal, capacity: one }) });
    expect(calgary.outcome).toBe('pending');
    expect(calgary.reason).toMatch(/1 other is already booked in your office on 2026-10-08 \(limit 1\)/);
  });
});
