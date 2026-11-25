import { jest } from '@jest/globals';

/**
 * Site visits name the office (25 Nov 2026):
 *   - "Which office?" is required for a site visit (an office, or "Other
 *     site" with a short text) on a new booking and on an edit that touches
 *     the type or the dates; older bookings without one stay valid;
 *   - "Site visit · Toronto" on the calendar, the requests and approvals;
 *   - the office (name + time zone) is copied onto the dashboard rows;
 *   - one visit booked both in Vacation Tracker and here counts once (the
 *     import's skip rule, the calendar, balances).
 * Invented people and places only (example.com).
 */

const prismaMock = {
  avRequest: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  avRequestEvent: { createMany: jest.fn(), count: jest.fn() },
  avLeaveType: { findUnique: jest.fn(), findMany: jest.fn() },
  avOffice: { findMany: jest.fn(), findUnique: jest.fn() },
  avPerson: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  avBalanceAdjustment: { findMany: jest.fn() },
  technicianLeave: { deleteMany: jest.fn(), create: jest.fn() },
};
const vtMock = { pushApproved: jest.fn(), pushCancelled: jest.fn(), cancelledHereExternalIds: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/availability/vtWriteBack.js', () => ({ default: vtMock, isVtExternalId: (id) => String(id || '').startsWith('vt:') }));
jest.unstable_mockModule('../src/services/availability/availabilityTeams.js', () => ({ default: { notify: jest.fn() } }));

const { default: svc, serializeRequest } = await import('../src/services/availability/availabilityService.js');
const site = await import('../src/services/availability/siteVisit.js');
const { toDay } = await import('../src/services/availability/availabilityRules.js');

const SITE = { id: 4, key: 'site_visit', name: 'Site visit', availability: 'ONSITE', unit: 'day', isActive: true, color: 'amber', visibility: 'public' };
const VACATION = { id: 1, key: 'vacation', name: 'Vacation', availability: 'OFF', unit: 'day', isActive: true, color: 'emerald', visibility: 'public' };
const OFFICES = [
  { id: 1, name: 'Vancouver', timezone: 'America/Vancouver', isActive: true },
  { id: 2, name: 'Toronto', timezone: 'America/Toronto', isActive: true },
  { id: 3, name: 'Old Depot', timezone: 'America/Edmonton', isActive: false },
];
const ME = { email: 'ari.stone@example.com', name: 'Ari Stone' };
const D = '2099-12-02';

let spies = [];
const spy = (name, impl) => { const s = jest.spyOn(svc, name).mockImplementation(impl); spies.push(s); return s; };
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.avOffice.findMany.mockResolvedValue(OFFICES);
  prismaMock.avOffice.findUnique.mockImplementation(async ({ where }) => OFFICES.find((o) => o.id === where.id) || null);
});

// ---------------------------------------------------------------- validation (pure)

describe('"Which office?" validation', () => {
  const ask = (input, opts = {}) => site.siteFieldsFor({ leaveType: SITE, input, offices: OFFICES, ...opts });

  test('a site visit needs an office or an "Other site" text', () => {
    expect(ask({ siteOfficeId: 2 })).toEqual({ siteOfficeId: 2, siteLocation: null });
    expect(ask({ siteOfficeId: '2' })).toEqual({ siteOfficeId: 2, siteLocation: null });
    expect(ask({ siteLocation: '  Client plant,   Kamloops ' })).toEqual({ siteOfficeId: null, siteLocation: 'Client plant, Kamloops' });
    expect(() => ask({})).toThrow('Pick which office the site visit is at (or "Other site")');
    expect(() => ask({ siteOfficeId: 'other', siteLocation: '   ' })).toThrow('Say which site you are visiting');
    expect(() => ask({ siteLocation: 'x'.repeat(161) })).toThrow('160 characters');
  });

  test('an unknown or retired office is refused, unless the edit keeps the one it had', () => {
    expect(() => ask({ siteOfficeId: 99 })).toThrow('Pick one of the offices');
    expect(() => ask({ siteOfficeId: 3 })).toThrow('Pick one of the offices');
    expect(ask({ siteOfficeId: 3 }, { existing: { siteOfficeId: 3 } })).toEqual({ siteOfficeId: 3, siteLocation: null });
  });

  test('not required (an edit that leaves type and dates alone): keeps what it had', () => {
    expect(ask({}, { required: false, existing: { siteOfficeId: null, siteLocation: null } })).toEqual({ siteOfficeId: null, siteLocation: null });
    expect(ask({}, { required: false, existing: { siteOfficeId: 2, siteLocation: null } })).toEqual({ siteOfficeId: 2, siteLocation: null });
  });

  test('other types never carry a place', () => {
    expect(site.siteFieldsFor({ leaveType: VACATION, input: { siteOfficeId: 2 }, offices: OFFICES })).toEqual({ siteOfficeId: null, siteLocation: null });
  });

  test('an edit has to answer again only when it touches the type or the dates', () => {
    const before = { leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D) };
    expect(site.editTouchesTypeOrDates(before, { leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D) })).toBe(false);
    expect(site.editTouchesTypeOrDates(before, { leaveTypeId: 4, startDate: toDay(D), endDate: toDay('2099-12-03') })).toBe(true);
    expect(site.editTouchesTypeOrDates(before, { leaveTypeId: 1, startDate: toDay(D), endDate: toDay(D) })).toBe(true);
  });
});

describe('the label', () => {
  test('"Site visit · Toronto", "Site visit · <other site>", or just the type', () => {
    expect(site.siteLabel('Site visit', site.sitePlaceOf({ siteOffice: { name: 'Toronto' } }))).toBe('Site visit · Toronto');
    expect(site.siteLabel('Site visit', site.sitePlaceOf({ siteOfficeId: 2 }, new Map(OFFICES.map((o) => [o.id, o]))))).toBe('Site visit · Toronto');
    expect(site.siteLabel('Site visit', site.sitePlaceOf({ siteLocation: 'Client plant, Kamloops' }))).toBe('Site visit · Client plant, Kamloops');
    expect(site.siteLabel('Site visit', site.sitePlaceOf({}))).toBe('Site visit');
  });

  test('a serialized request carries the office, the text and the place', () => {
    const out = serializeRequest({ id: 7, email: ME.email, leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), siteOfficeId: 2, siteLocation: null, siteOffice: { id: 2, name: 'Toronto' } });
    expect(out).toMatchObject({ siteOfficeId: 2, siteLocation: null, sitePlace: 'Toronto' });
    expect(serializeRequest({ id: 8, email: ME.email, leaveTypeId: 1, startDate: toDay(D), endDate: toDay(D) })).toMatchObject({ siteOfficeId: null, siteLocation: null, sitePlace: null });
  });
});

// ---------------------------------------------------------------- booking and changing

describe('booking a site visit', () => {
  const shaped = (type) => ({ leaveType: type, startDate: toDay(D), endDate: toDay(D), dayPart: 'full', startMinute: null, endMinute: null, dates: [toDay(D)], days: 1, hours: 8, note: null });
  beforeEach(() => {
    spy('ensurePerson', async (u) => ({ email: u.email, name: u.name || 'Someone', workdays: [1, 2, 3, 4, 5], dailyHours: 8 }));
    spy('_decideFor', async () => ({ outcome: 'approved', reason: null, fired: [] }));
    spy('getSettings', async () => ({ outlookEventsEnabled: false, autoRepliesEnabled: false, yearStartMonth: 1 }));
    spy('getRequest', async (id) => ({ id }));
    spy('project', async () => ({ written: 1 }));
    spy('_teamsSubmitted', async () => {});
    prismaMock.avRequest.findFirst.mockResolvedValue(null);
    prismaMock.avRequest.create.mockImplementation(async ({ data }) => ({ id: 574, ...data }));
  });

  test('without an office it is refused and nothing is written', async () => {
    spy('_shape', async () => shaped(SITE));
    await expect(svc.submit(ME, { leaveTypeId: 4, startDate: D })).rejects.toThrow('Pick which office');
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
  });

  test('with Toronto it is booked with the office; with "Other site" with the text', async () => {
    spy('_shape', async () => shaped(SITE));
    await svc.submit(ME, { leaveTypeId: 4, startDate: D, siteOfficeId: 2 });
    expect(prismaMock.avRequest.create.mock.calls[0][0].data).toMatchObject({ leaveTypeId: 4, siteOfficeId: 2, siteLocation: null, status: 'approved' });
    await svc.submit(ME, { leaveTypeId: 4, startDate: D, siteOfficeId: 'other', siteLocation: 'Client plant, Kamloops' });
    expect(prismaMock.avRequest.create.mock.calls[1][0].data).toMatchObject({ siteOfficeId: null, siteLocation: 'Client plant, Kamloops' });
  });

  test('other types are booked as before (no office asked, none stored)', async () => {
    spy('_shape', async () => shaped(VACATION));
    await svc.submit(ME, { leaveTypeId: 1, startDate: D, siteOfficeId: 2 });
    const data = prismaMock.avRequest.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('siteOfficeId');
    expect(prismaMock.avOffice.findMany).not.toHaveBeenCalled();
  });
});

describe('changing a waiting site visit', () => {
  const older = () => ({
    id: 210, email: ME.email, leaveTypeId: 4, status: 'pending', source: 'app', startDate: toDay(D), endDate: toDay(D), dayPart: 'full',
    startMinute: null, endMinute: null, days: 1, hours: 8, note: null, siteOfficeId: null, siteLocation: null, decision: { approvers: [] },
  });
  beforeEach(() => {
    prismaMock.avRequest.findUnique.mockResolvedValue(older());
    prismaMock.avRequest.findFirst.mockResolvedValue(null);
    prismaMock.avRequest.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.avRequestEvent.createMany.mockResolvedValue({ count: 2 });
    prismaMock.avRequestEvent.count.mockResolvedValue(1);
    spy('ensurePerson', async (u) => ({ email: u.email, name: 'Ari Stone', workdays: [1, 2, 3, 4, 5], dailyHours: 8 }));
    spy('_decideFor', async () => ({ outcome: 'pending', reason: null, fired: [] }));
    spy('getSettings', async () => ({ outlookEventsEnabled: false, autoRepliesEnabled: false, yearStartMonth: 1 }));
    spy('approversFor', async () => ['robin.diaz@example.com']);
    spy('getRequest', async (id) => ({ id }));
    spy('_notifyApprovers', async () => {});
    spy('_teamsSubmitted', async () => {});
  });

  test('an older booking without an office can still have its note changed', async () => {
    spy('_shape', async () => ({ leaveType: SITE, startDate: toDay(D), endDate: toDay(D), dayPart: 'full', startMinute: null, endMinute: null, dates: [toDay(D)], days: 1, hours: 8, note: 'Bring the badge' }));
    await svc.updateRequest(210, ME, { leaveTypeId: 4, startDate: D, note: 'Bring the badge' });
    expect(prismaMock.avRequest.updateMany.mock.calls[0][0].data).toMatchObject({ note: 'Bring the badge', siteOfficeId: null, siteLocation: null });
  });

  test('moving its dates asks "Which office?" again', async () => {
    const moved = { leaveType: SITE, startDate: toDay('2099-12-03'), endDate: toDay('2099-12-03'), dayPart: 'full', startMinute: null, endMinute: null, dates: [toDay('2099-12-03')], days: 1, hours: 8, note: null };
    spy('_shape', async () => moved);
    await expect(svc.updateRequest(210, ME, { leaveTypeId: 4, startDate: '2099-12-03' })).rejects.toThrow('Pick which office');
    expect(prismaMock.avRequest.updateMany).not.toHaveBeenCalled();
    await svc.updateRequest(210, ME, { leaveTypeId: 4, startDate: '2099-12-03', siteOfficeId: 2 });
    const call = prismaMock.avRequest.updateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({ siteOfficeId: 2 });
    const edited = prismaMock.avRequestEvent.createMany.mock.calls[0][0].data[0];
    expect(edited.details.changed).toEqual(expect.arrayContaining(['startDate', 'siteOfficeId']));
  });
});

// ---------------------------------------------------------------- calendar, projection, balances

describe('the calendar (wallchart, overview, out today)', () => {
  beforeEach(() => {
    spy('_privilegedIn', async () => true);
    spy('rosterFor', async () => new Set([ME.email, 'bo.reyes@example.com']));
    spy('_holidayNames', async () => ({}));
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: ME.email, name: 'Ari Stone', officeId: 1 }, { email: 'bo.reyes@example.com', name: 'Bo Reyes', officeId: 1 }]);
    prismaMock.avLeaveType.findMany.mockResolvedValue([SITE, VACATION]);
  });

  test('a site visit names its place; the Vacation Tracker copy of the same visit is dropped', async () => {
    const base = { leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), dayPart: 'full', startMinute: null, endMinute: null, status: 'approved', days: 1 };
    prismaMock.avRequest.findMany.mockResolvedValue([
      { ...base, id: 574, email: ME.email, source: 'app', siteOfficeId: 2, siteLocation: null, siteOffice: { name: 'Toronto' } },
      { ...base, id: 575, email: ME.email, source: 'vacation_tracker', siteOfficeId: null, siteLocation: null, siteOffice: null },
      { ...base, id: 576, email: 'bo.reyes@example.com', source: 'app', siteOfficeId: null, siteLocation: 'Client plant, Kamloops', siteOffice: null },
      { ...base, id: 577, email: 'bo.reyes@example.com', leaveTypeId: 1, source: 'vacation_tracker', startDate: toDay('2099-12-04'), endDate: toDay('2099-12-04'), siteOffice: null },
    ]);
    const out = await svc.calendar(ME, { from: '2099-12-01', to: '2099-12-31', workspaceId: 1 });
    expect(out.entries.map((e) => e.id)).toEqual([574, 576, 577]);
    expect(out.entries[0]).toMatchObject({ label: 'Site visit', place: 'Toronto' });
    expect(out.entries[1]).toMatchObject({ label: 'Site visit', place: 'Client plant, Kamloops' });
    expect(out.entries[2]).toMatchObject({ label: 'Vacation', place: null });
  });
});

describe('projection into the dashboard rows', () => {
  beforeEach(() => {
    prismaMock.avPerson.findUnique.mockResolvedValue({ email: ME.email, workdays: [1, 2, 3, 4, 5] });
    spy('_holidays', async () => []);
    spy('_projectionTargets', async () => [{ id: 11, workspaceId: 1 }]);
    prismaMock.technicianLeave.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.technicianLeave.create.mockResolvedValue({});
  });
  const req = (extra) => ({ id: 574, email: ME.email, leaveTypeId: 4, status: 'approved', startDate: toDay(D), endDate: toDay(D), dayPart: 'full', ...extra });

  test('an office visit carries the office name and time zone', async () => {
    prismaMock.avLeaveType.findUnique.mockResolvedValue(SITE);
    await svc.project(req({ siteOfficeId: 2 }));
    expect(prismaMock.technicianLeave.create.mock.calls[0][0].data).toMatchObject({
      vtLeaveId: 'av:574:w1', leaveTypeName: 'Site visit', category: 'OTHER', siteLocation: 'Toronto', siteTimezone: 'America/Toronto',
    });
  });

  test('"Other site" carries the text and no time zone; other types carry nothing', async () => {
    prismaMock.avLeaveType.findUnique.mockResolvedValue(SITE);
    await svc.project(req({ siteLocation: 'Client plant, Kamloops' }));
    expect(prismaMock.technicianLeave.create.mock.calls[0][0].data).toMatchObject({ siteLocation: 'Client plant, Kamloops', siteTimezone: null });
    prismaMock.avLeaveType.findUnique.mockResolvedValue(VACATION);
    await svc.project(req({ leaveTypeId: 1 }));
    expect(prismaMock.technicianLeave.create.mock.calls[1][0].data).not.toHaveProperty('siteLocation');
  });
});

describe('balances count a twice-booked leave once', () => {
  test('a Vacation Tracker copy covered by the booking here is not counted', async () => {
    const person = { email: ME.email, startDate: null, entitlementOverrides: null };
    prismaMock.avBalanceAdjustment.findMany.mockResolvedValue([]);
    prismaMock.avRequest.findMany.mockResolvedValue([
      { days: 2, status: 'approved', startDate: toDay('2099-12-01'), endDate: toDay('2099-12-02'), source: 'app' },
      { days: 2, status: 'approved', startDate: toDay('2099-12-01'), endDate: toDay('2099-12-02'), source: 'vacation_tracker' },
      { days: 1, status: 'approved', startDate: toDay('2099-12-09'), endDate: toDay('2099-12-09'), source: 'vacation_tracker' },
    ]);
    const type = { ...VACATION, tracksBalance: true, balancePolicy: { annualDays: 10 } };
    const b = await svc._balanceFor(person, type, 2099, { yearStartMonth: 1 });
    expect(b.scheduled).toBe(3);
  });
});

// ---------------------------------------------------------------- the import's skip rule

describe('Vacation Tracker import: a visit already booked here is not imported again', () => {
  const client = (leaves) => ({
    fetchLeaveTypes: jest.fn().mockResolvedValue([{ id: 'lt-site', name: 'Site Visit' }]),
    fetchUsers: jest.fn().mockResolvedValue([
      { id: 'u1', email: ME.email, name: 'Ari Stone' },
      { id: 'u2', email: 'bo.reyes@example.com', name: 'Bo Reyes' },
    ]),
    fetchLeaves: jest.fn().mockResolvedValue(leaves),
  });
  const appBooking = { id: 574, email: ME.email, leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), dayPart: 'full', status: 'approved', source: 'app', externalId: null };

  beforeEach(() => {
    spy('ensureSeed', async () => {});
    spy('syncPeople', async () => ({}));
    spy('_holidays', async () => []);
    spy('project', async () => ({ written: 1 }));
    spy('unproject', async () => ({ deleted: 0 }));
    vtMock.cancelledHereExternalIds.mockResolvedValue(new Set());
    prismaMock.avLeaveType.findMany.mockResolvedValue([{ ...SITE, vtLeaveTypeNames: ['site visit', 'field'] }]);
    prismaMock.avPerson.findMany.mockResolvedValue([{ email: ME.email, workdays: null, dailyHours: 8 }, { email: 'bo.reyes@example.com', workdays: null, dailyHours: 8 }]);
    prismaMock.avRequest.create.mockResolvedValue({ id: 900, status: 'approved' });
    // Imported copies: none yet. Bookings here (source not vacation_tracker): Ari's Toronto visit.
    prismaMock.avRequest.findMany.mockImplementation(async ({ where }) => {
      if (where.source === 'vacation_tracker') return [];
      if (where.externalId) return [];
      return [appBooking];
    });
  });

  test('same person, type and dates: skipped with a log line; another person is imported', async () => {
    const leaves = [
      { id: 'leaveRequest-a1', userId: 'u1', leaveTypeId: 'lt-site', startDate: D, endDate: D, status: 'APPROVED', isFullDayLeave: true },
      { id: 'leaveRequest-b2', userId: 'u2', leaveTypeId: 'lt-site', startDate: D, endDate: D, status: 'APPROVED', isFullDayLeave: true },
    ];
    const out = await svc.syncFromVacationTracker(1, { from: '2099-11-01', to: '2099-12-31', client: client(leaves) });
    expect(out).toMatchObject({ created: 1, duplicates: 1 });
    expect(prismaMock.avRequest.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.avRequest.create.mock.calls[0][0].data).toMatchObject({ email: 'bo.reyes@example.com', externalId: 'vt:leaveRequest-b2' });
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('leaveRequest-a1 not imported'));
  });

  test('overlapping dates count as the same visit; a different type does not', async () => {
    prismaMock.avLeaveType.findMany.mockResolvedValue([{ ...SITE, vtLeaveTypeNames: ['site visit'] }, { ...VACATION, vtLeaveTypeNames: ['vacation'] }]);
    const c = client([
      { id: 'leaveRequest-a3', userId: 'u1', leaveTypeId: 'lt-site', startDate: '2099-12-01', endDate: '2099-12-03', status: 'APPROVED', isFullDayLeave: true },
      { id: 'leaveRequest-a4', userId: 'u1', leaveTypeId: 'lt-vac', startDate: D, endDate: D, status: 'APPROVED', isFullDayLeave: true },
    ]);
    c.fetchLeaveTypes.mockResolvedValue([{ id: 'lt-site', name: 'Site Visit' }, { id: 'lt-vac', name: 'Vacation' }]);
    const out = await svc.syncFromVacationTracker(1, { from: '2099-11-01', to: '2099-12-31', client: c });
    expect(out).toMatchObject({ created: 1, duplicates: 1 });
    expect(prismaMock.avRequest.create.mock.calls[0][0].data).toMatchObject({ externalId: 'vt:leaveRequest-a4', leaveTypeId: 1 });
  });
});

// ---------------------------------------------------------------- de-duplication helpers (pure)

describe('de-duplication helpers', () => {
  const avTypes = [{ id: 4, name: 'Site visit', vtLeaveTypeNames: ['site visit', 'field', 'business trip'] }, { id: 1, name: 'Vacation', vtLeaveTypeNames: ['vacation', 'pto'] }];
  const day = new Date('2099-12-02T00:00:00Z');

  test('a Vacation Tracker row repeating a Vacation Pulse row is a pair (by the type its name maps to)', () => {
    const rows = [
      { id: 1, technicianId: 11, leaveDate: day, vtLeaveId: 'av:574:w1', leaveTypeName: 'Site visit', category: 'OTHER' },
      { id: 2, technicianId: 11, leaveDate: day, vtLeaveId: 'leaveRequest-a1', leaveTypeName: 'Business Trip', category: 'OTHER' },
      { id: 3, technicianId: 11, leaveDate: day, vtLeaveId: 'leaveRequest-a2', leaveTypeName: 'PTO', category: 'OFF' },
      { id: 4, technicianId: 12, leaveDate: day, vtLeaveId: 'leaveRequest-b1', leaveTypeName: 'Site Visit', category: 'OTHER' },
      { id: 5, technicianId: 11, leaveDate: day, vtLeaveId: 'graph:abc', leaveTypeName: 'Site visit', category: 'OTHER' },
    ];
    const pairs = site.duplicateLeavePairs(rows, avTypes);
    expect(pairs.map((p) => [p.vtRow.id, p.appRow.id])).toEqual([[2, 1]]);
  });

  test('rows of one person and day collapse by kind, the Vacation Pulse row first', () => {
    const rows = [
      { technicianId: 11, leaveDate: day, vtLeaveId: 'leaveRequest-a1', leaveTypeName: 'Site Visit', category: 'OTHER', isFullDay: true },
      { technicianId: 11, leaveDate: day, vtLeaveId: 'av:574:w1', leaveTypeName: 'Site visit', category: 'OTHER', isFullDay: true, siteLocation: 'Toronto' },
      { technicianId: 11, leaveDate: day, vtLeaveId: 'leaveRequest-a5', leaveTypeName: 'Physio', category: 'OTHER', isFullDay: true },
    ];
    const out = site.collapseLeaveRows(rows);
    expect(out.map((r) => r.vtLeaveId)).toEqual(['av:574:w1', 'leaveRequest-a5']);
  });

  test('the import twin: same person and type, overlapping dates; exact dates preferred', () => {
    const fields = { email: 'ARI.STONE@example.com', leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D) };
    const twin = site.findAppTwin(fields, [
      { id: 1, email: ME.email, leaveTypeId: 4, startDate: toDay('2099-12-01'), endDate: toDay('2099-12-03'), status: 'approved', source: 'app' },
      { id: 2, email: ME.email, leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), status: 'pending', source: 'app' },
      { id: 3, email: ME.email, leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), status: 'cancelled', source: 'app' },
    ]);
    expect(twin.id).toBe(2);
    expect(site.findAppTwin({ ...fields, leaveTypeId: 1 }, [{ id: 1, email: ME.email, leaveTypeId: 4, startDate: toDay(D), endDate: toDay(D), status: 'approved', source: 'app' }])).toBeNull();
  });
});
