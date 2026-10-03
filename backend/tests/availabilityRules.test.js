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
