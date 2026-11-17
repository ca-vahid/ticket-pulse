import { jest } from '@jest/globals';

/**
 * QA 11-16: Accounting's shared calendar → Vacation Pulse. The hourly
 * calendar sync's classified rows become approved requests (source
 * 'shared_calendar'), per workspace Off / Shadow / Live.
 * Invented people only (example.com).
 */

const prismaMock = {
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  avLeaveType: { findMany: jest.fn(), findUnique: jest.fn() },
  avPerson: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  avRequest: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  calendarLeaveSourceConfig: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  calendarLeaveRule: { findMany: jest.fn() },
  calendarLeaveAlias: { findMany: jest.fn() },
  calendarLeaveClassification: { findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  technicianLeave: { findMany: jest.fn(), deleteMany: jest.fn() },
  vacationTrackerConfig: { findMany: jest.fn() },
};
const store = new Map();
const settingsMock = {
  get: jest.fn(async (k) => store.get(k) ?? null),
  set: jest.fn(async (k, v) => { store.set(k, String(v)); return {}; }),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: { sendJson: jest.fn() } }));
jest.unstable_mockModule('../src/services/vacationTrackerRepository.js', () => ({ default: { bulkUpsertLeaves: jest.fn().mockResolvedValue({}) } }));

const cal = await import('../src/services/availability/calendarImport.js');
const { default: calendarLeaveService } = await import('../src/services/calendarLeaveService.js');
const { default: availabilityService } = await import('../src/services/availability/availabilityService.js');

const {
  planCalendarRow, mapEventDates, leaveTypeKeyFor, importCalendarRows, calendarExternalId, CAL_IMPORT_STATUS_KEY, calImportModeKey,
} = cal;

const TYPES = [
  { id: 1, key: 'vacation', name: 'Vacation' },
  { id: 2, key: 'sick', name: 'Sick' },
  { id: 3, key: 'wfh', name: 'Working from home' },
  { id: 5, key: 'training', name: 'Training / conference' },
  { id: 6, key: 'appointment', name: 'Appointment' },
  { id: 7, key: 'bereavement', name: 'Bereavement' },
  { id: 8, key: 'banked', name: 'Banked time' },
  { id: 9, key: 'unpaid', name: 'Unpaid leave' },
];
const ANA = { id: 41, name: 'Ana Example', email: 'ana.example@example.com', isActive: true };

const allDay = (id, subject, start, endExclusive) => ({
  id, subject, isAllDay: true, start: { dateTime: `${start}T00:00:00.0000000` }, end: { dateTime: `${endExclusive}T00:00:00.0000000` },
});
const timed = (id, subject, day, from, to) => ({
  id, subject, isAllDay: false, start: { dateTime: `${day}T${from}:00.0000000` }, end: { dateTime: `${day}T${to}:00.0000000` },
});
const row = (event, over = {}) => ({
  event, subject: event.subject, technicianId: ANA.id, technician: ANA, category: 'OFF', halfDayPart: null,
  isLeave: true, requiresReview: false, nameGuess: 'Ana', personAlias: null, ...over,
});

const av = {
  _holidays: jest.fn().mockResolvedValue([]),
  project: jest.fn().mockResolvedValue({ written: 1 }),
  unproject: jest.fn().mockResolvedValue({ deleted: 1 }),
};

let existing;
let others;
beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  existing = [];
  others = [];
  prismaMock.technician.findMany.mockResolvedValue([{ email: ANA.email }]);
  prismaMock.avLeaveType.findMany.mockResolvedValue(TYPES);
  prismaMock.avPerson.findMany.mockResolvedValue([{ email: ANA.email, name: ANA.name, workdays: null, dailyHours: 8 }]);
  prismaMock.avRequest.findMany.mockImplementation(async ({ where }) => (where.source === 'shared_calendar' ? existing : others));
  prismaMock.avRequest.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  prismaMock.avRequest.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
});

const WINDOW = { windowStart: '2099-11-01', windowEnd: '2100-11-01' };
const live = (rows, extra = {}) => importCalendarRows(2, rows, { av, mode: 'live', ...WINDOW, ...extra });

describe('mapping table', () => {
  test.each([
    ['Ana - Vacation', 'OFF', 'vacation'],
    ['Ana sick', 'OFF', 'sick'],
    ['Ana dentist appt', 'OFF', 'appointment'],
    ['Ana - Doctor', 'OFF', 'appointment'],
    ['Ana conference', 'OFF', 'training'],
    ['Ana class', 'OFF', 'training'],
    ['Ana bereavement', 'OFF', 'bereavement'],
    ['Ana - in lieu of overtime', 'OFF', 'banked'],
    ['Ana banked day', 'OFF', 'banked'],
    ['Ana unpaid leave', 'OFF', 'unpaid'],
    ['Ana - Working Remote', 'WFH', 'wfh'],
    ['Ana OFF (ok by manager)', 'OFF', 'vacation'],
  ])('%s (%s) → %s', (subject, category, key) => {
    expect(leaveTypeKeyFor({ subject, category })).toBe(key);
  });

  test('a multi-day all-day entry is one request; Graph end is exclusive', () => {
    expect(mapEventDates(allDay('e', 'Ana - Vacation', '2099-12-01', '2099-12-06'))).toEqual({
      startDate: '2099-12-01', endDate: '2099-12-05', dayPart: 'full', startMinute: null, endMinute: null,
    });
  });

  test('all-day with an AM/PM keyword is a half day', () => {
    expect(mapEventDates(allDay('e', 'Ana off PM', '2099-12-01', '2099-12-02'), 'PM')).toMatchObject({ dayPart: 'pm', endDate: '2099-12-01' });
  });

  test('timed: under 3 h stays hours with its times; 3 h+ is morning/afternoon; 6 h+ is a full day', () => {
    expect(mapEventDates(timed('e', 'Ana dentist', '2099-12-01', '10:00', '12:00'))).toEqual({
      startDate: '2099-12-01', endDate: '2099-12-01', dayPart: 'hours', startMinute: 600, endMinute: 720,
    });
    expect(mapEventDates(timed('e', 'Ana off', '2099-12-01', '08:00', '12:00'))).toMatchObject({ dayPart: 'am', startMinute: 480, endMinute: 720 });
    expect(mapEventDates(timed('e', 'Ana off', '2099-12-01', '12:30', '16:30'))).toMatchObject({ dayPart: 'pm' });
    expect(mapEventDates(timed('e', 'Ana off', '2099-12-01', '08:00', '16:30'))).toMatchObject({ dayPart: 'full', startMinute: null });
  });

  test('a timed entry over several days covers them in full', () => {
    const ev = { id: 'e', subject: 'Ana away', isAllDay: false, start: { dateTime: '2099-12-01T09:00:00' }, end: { dateTime: '2099-12-03T17:00:00' } };
    expect(mapEventDates(ev)).toMatchObject({ startDate: '2099-12-01', endDate: '2099-12-03', dayPart: 'full' });
  });

  test('skips: tentative, placeholder, showAs tentative, private, review, unmatched, ignored, other', () => {
    const ev = allDay('e1', 'Ana - Vacation', '2099-12-01', '2099-12-02');
    expect(planCalendarRow(row({ ...ev, subject: 'Ana vacation placeholder (tentative)' })).skip).toBe('skipped_tentative');
    expect(planCalendarRow(row({ ...ev, subject: 'Ana placeholder' })).skip).toBe('skipped_tentative');
    expect(planCalendarRow(row({ ...ev, showAs: 'tentative' })).skip).toBe('skipped_tentative');
    expect(planCalendarRow(row({ ...ev, sensitivity: 'private' })).skip).toBe('skipped_private');
    expect(planCalendarRow(row(ev, { requiresReview: true })).skip).toBe('skipped_review');
    expect(planCalendarRow(row(ev, { technicianId: null, technician: null, requiresReview: true, nameGuess: 'Zed' }))).toEqual({ skip: 'skipped_unmatched', name: 'Zed' });
    expect(planCalendarRow(row(ev, { category: 'IGNORED', isLeave: false })).skip).toBe('skipped_ignored');
    expect(planCalendarRow(row(ev, { category: 'OTHER' })).skip).toBe('skipped_other');
    expect(planCalendarRow(row(ev)).plan).toMatchObject({ email: ANA.email, typeKey: 'vacation', externalId: calendarExternalId('e1') });
  });

  test('externalId is cal: + sha256 of the Graph id (fits VarChar(255))', () => {
    const id = calendarExternalId('AAMk'.repeat(100));
    expect(id).toMatch(/^cal:[0-9a-f]{64}$/);
  });
});

describe('live import', () => {
  const ev = allDay('evt-1', 'Ana - Vacation', '2099-12-01', '2099-12-04');

  test('a new entry becomes one approved request, no approvals, and is projected', async () => {
    const out = await live([row(ev)]);
    expect(out.counts.created).toBe(1);
    const data = prismaMock.avRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      email: ANA.email, leaveTypeId: 1, dayPart: 'full', days: 3, status: 'approved', source: 'shared_calendar',
      externalId: calendarExternalId('evt-1'), createdBy: 'shared_calendar', decidedBy: 'shared_calendar',
      events: { create: { kind: 'imported', actor: 'shared_calendar' } },
    });
    expect(data.wantsOutlookEvent).toBeUndefined();
    expect(av.project).toHaveBeenCalledTimes(1);
  });

  test('a 2-hour dentist slot carries its part of the day', async () => {
    await live([row(timed('evt-d', 'Ana dentist', '2099-12-02', '14:00', '16:00'))]);
    expect(prismaMock.avRequest.create.mock.calls[0][0].data).toMatchObject({ leaveTypeId: 6, dayPart: 'hours', startMinute: 840, endMinute: 960, hours: 2 });
  });

  test('idempotent: a second run with the same entry changes nothing', async () => {
    existing = [{
      id: 70, email: ANA.email, externalId: calendarExternalId('evt-1'), leaveTypeId: 1, startDate: new Date('2099-12-01'), endDate: new Date('2099-12-03'),
      dayPart: 'full', startMinute: null, endMinute: null, status: 'approved', events: [],
    }];
    const out = await live([row(ev)]);
    expect(out.counts).toMatchObject({ created: 0, updated: 0, cancelled: 0, unchanged: 1 });
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
  });

  test('moved dates: the request is updated and re-projected', async () => {
    existing = [{
      id: 70, email: ANA.email, externalId: calendarExternalId('evt-1'), leaveTypeId: 1, startDate: new Date('2099-11-24'), endDate: new Date('2099-11-26'),
      dayPart: 'full', startMinute: null, endMinute: null, status: 'approved', events: [],
    }];
    const out = await live([row(ev)]);
    expect(out.counts.updated).toBe(1);
    const call = prismaMock.avRequest.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 70 });
    expect(call.data.events.create.kind).toBe('synced_update');
    expect(av.unproject).toHaveBeenCalled();
    expect(av.project).toHaveBeenCalled();
  });

  test('gone from the calendar (and now held for review) inside the window: cancelled', async () => {
    existing = [
      { id: 71, email: ANA.email, externalId: calendarExternalId('gone'), leaveTypeId: 1, startDate: new Date('2099-12-10'), endDate: new Date('2099-12-10'), dayPart: 'full', status: 'approved', events: [] },
      { id: 72, email: ANA.email, externalId: calendarExternalId('evt-1'), leaveTypeId: 1, startDate: new Date('2099-12-01'), endDate: new Date('2099-12-03'), dayPart: 'full', status: 'approved', events: [] },
      { id: 73, email: ANA.email, externalId: calendarExternalId('old'), leaveTypeId: 1, startDate: new Date('2099-01-10'), endDate: new Date('2099-01-10'), dayPart: 'full', status: 'approved', events: [] },
    ];
    const out = await live([row(ev, { requiresReview: true }), row(allDay('other', 'Ana - Vacation', '2099-12-20', '2099-12-21'))]);
    expect(out.counts.cancelled).toBe(2);
    const cancelledIds = prismaMock.avRequest.update.mock.calls.filter((c) => c[0].data.status === 'cancelled').map((c) => c[0].where.id).sort();
    expect(cancelledIds).toEqual([71, 72]); // 73 starts before the window
    const details = prismaMock.avRequest.update.mock.calls[0][0].data.events.create.details;
    expect(details.source).toBe('shared_calendar');
  });

  test('empty listing guard: Graph returned nothing, nothing is cancelled', async () => {
    existing = [{ id: 71, email: ANA.email, externalId: calendarExternalId('gone'), leaveTypeId: 1, startDate: new Date('2099-12-10'), endDate: new Date('2099-12-10'), dayPart: 'full', status: 'approved', events: [] }];
    const out = await live([], { eventsListed: 0 });
    expect(out.counts.cancelled).toBe(0);
    expect(out.guard).toBe(true);
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
  });

  test('already booked in Vacation Pulse: skipped, the app request untouched', async () => {
    others = [{ email: ANA.email, startDate: new Date('2099-12-02'), endDate: new Date('2099-12-02') }];
    const out = await live([row(ev)]);
    expect(out.counts).toMatchObject({ created: 0, skipped_app_booked: 1 });
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
    const otherQuery = prismaMock.avRequest.findMany.mock.calls.find((c) => c[0].where.source?.not === 'shared_calendar');
    expect(otherQuery[0].where.status).toEqual({ in: ['approved', 'pending'] });
  });

  test('cancelled in Vacation Pulse by a person: stays cancelled', async () => {
    existing = [{
      id: 70, email: ANA.email, externalId: calendarExternalId('evt-1'), leaveTypeId: 1, startDate: new Date('2099-12-01'), endDate: new Date('2099-12-03'),
      dayPart: 'full', status: 'cancelled', events: [{ id: 5, kind: 'cancelled', details: { cancelledIn: 'ticket_pulse' } }],
    }];
    const out = await live([row(ev)]);
    expect(out.counts).toMatchObject({ created: 0, updated: 0, skipped_cancelled_here: 1 });
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
  });

  test('cancelled by the import earlier and back on the calendar: approved again', async () => {
    existing = [{
      id: 70, email: ANA.email, externalId: calendarExternalId('evt-1'), leaveTypeId: 1, startDate: new Date('2099-12-01'), endDate: new Date('2099-12-03'),
      dayPart: 'full', status: 'cancelled', events: [{ id: 5, kind: 'cancelled', details: { source: 'shared_calendar' } }],
    }];
    const out = await live([row(ev)]);
    expect(out.counts.updated).toBe(1);
    expect(prismaMock.avRequest.update.mock.calls[0][0].data.status).toBe('approved');
  });

  test('tentative and private entries are skipped and counted; unmatched names are listed', async () => {
    const out = await live([
      row({ ...ev, id: 't1', subject: 'Ana vacation placeholder (tentative)' }),
      row({ ...ev, id: 'p1', sensitivity: 'private' }),
      row({ ...ev, id: 'u1', subject: 'Zed - Vacation' }, { technicianId: null, technician: null, requiresReview: true, nameGuess: 'Zed' }),
      row({ ...ev, id: 'u2', subject: 'Zed - Off' }, { technicianId: null, technician: null, requiresReview: true, nameGuess: 'Zed' }),
    ]);
    expect(out.counts).toMatchObject({ created: 0, skipped_tentative: 1, skipped_private: 1, skipped_unmatched: 2 });
    expect(out.unmatched).toEqual([{ name: 'Zed', events: 2 }]);
    expect(out.tentative[0]).toMatchObject({ date: '2099-12-01' });
  });
});

describe('modes', () => {
  const ev = allDay('evt-1', 'Ana - Vacation', '2099-12-01', '2099-12-04');

  test('Shadow writes nothing and records what it would do', async () => {
    existing = [{ id: 71, email: ANA.email, externalId: calendarExternalId('gone'), leaveTypeId: 1, startDate: new Date('2099-12-10'), endDate: new Date('2099-12-10'), dayPart: 'full', status: 'approved', events: [] }];
    const out = await importCalendarRows(2, [row(ev)], { av, mode: 'shadow', ...WINDOW });
    expect(out.counts).toMatchObject({ created: 1, cancelled: 1 });
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.avRequest.update).not.toHaveBeenCalled();
    expect(prismaMock.avPerson.create).not.toHaveBeenCalled();
    expect(av.project).not.toHaveBeenCalled();
    const saved = JSON.parse(store.get(CAL_IMPORT_STATUS_KEY));
    expect(saved['2']).toMatchObject({ mode: 'shadow', ok: true, counts: { created: 1, cancelled: 1 } });
    expect(saved['2'].would.create[0]).toMatchObject({ type: 'Vacation', start: '2099-12-01', end: '2099-12-03' });
  });

  test('the mode comes from app settings and defaults to off', async () => {
    expect(await calendarLeaveService.importToVacationPulse(2, [row(ev)])).toEqual({ mode: 'off' });
    expect(prismaMock.avRequest.findMany).not.toHaveBeenCalled();
    store.set(calImportModeKey(2), 'shadow');
    const out = await calendarLeaveService.importToVacationPulse(2, [row(ev)], WINDOW);
    expect(out.mode).toBe('shadow');
    expect(prismaMock.avRequest.create).not.toHaveBeenCalled();
  });
});

describe('no double counting on the dashboard', () => {
  test('shared calendar requests are not projected where the calendar sync is on', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 41, workspaceId: 2 }, { id: 99, workspaceId: 5 }]);
    prismaMock.calendarLeaveSourceConfig.findMany.mockResolvedValue([{ workspaceId: 2 }]);
    const targets = await availabilityService._projectionTargets({ email: ANA.email, source: 'shared_calendar' });
    expect(targets).toEqual([{ id: 99, workspaceId: 5 }]);
    const appTargets = await availabilityService._projectionTargets({ email: ANA.email, source: 'app' });
    expect(appTargets).toHaveLength(2);
  });
});

describe('Settings → Import (admins)', () => {
  const ADMIN = { email: 'ops.admin@example.com', role: 'admin' };
  test('status lists each calendar workspace with its mode and last run; mode is saved in app settings', async () => {
    prismaMock.calendarLeaveSourceConfig.findMany.mockResolvedValue([{ workspaceId: 2, syncEnabled: true, lookbackDays: 7, horizonDays: 90, lastSyncAt: null, workspace: { name: 'Accounting Team' } }]);
    prismaMock.calendarLeaveSourceConfig.findUnique.mockResolvedValue({ workspaceId: 2 });
    store.set(CAL_IMPORT_STATUS_KEY, JSON.stringify({ 2: { at: '2099-11-16T23:15:00.000Z', mode: 'shadow', ok: true, counts: { created: 4 } } }));
    let status = await availabilityService.calendarImportStatus(ADMIN);
    expect(status.workspaces[0]).toMatchObject({ workspaceId: 2, name: 'Accounting Team', mode: 'off', lastRun: { counts: { created: 4 } } });
    expect(await availabilityService.setCalendarImportMode(ADMIN, { workspaceId: 2, mode: 'live' })).toEqual({ workspaceId: 2, mode: 'live' });
    expect(store.get('calendar_vp_mode_ws2')).toBe('live');
    status = await availabilityService.calendarImportStatus(ADMIN);
    expect(status.workspaces[0].mode).toBe('live');
    await expect(availabilityService.setCalendarImportMode(ADMIN, { workspaceId: 2, mode: 'sometimes' })).rejects.toThrow(/Off, Shadow or Live/);
  });
});

describe('the hourly sync', () => {
  test('hands its classified rows to the import (one Graph read) and drops dashboard rows cancelled in Vacation Pulse', async () => {
    const { default: vtRepo } = await import('../src/services/vacationTrackerRepository.js');
    prismaMock.calendarLeaveSourceConfig.findUnique.mockResolvedValue({ workspaceId: 2, graphGroupId: 'g', timezone: 'America/Vancouver', lookbackDays: 30, horizonDays: 365 });
    prismaMock.calendarLeaveSourceConfig.update.mockResolvedValue({});
    prismaMock.technicianLeave.findMany.mockResolvedValue([]);
    const kept = row(allDay('keep', 'Ana - Vacation', '2099-12-01', '2099-12-02'));
    const dropped = row(allDay('gone-here', 'Ana - Vacation', '2099-12-08', '2099-12-09'));
    existing = [{ externalId: calendarExternalId('gone-here'), status: 'cancelled', events: [{ id: 1, kind: 'cancelled', details: { cancelledIn: 'ticket_pulse' } }] }];
    const fetchSpy = jest.spyOn(calendarLeaveService, 'fetchEvents').mockResolvedValue([kept.event, dropped.event]);
    const classifySpy = jest.spyOn(calendarLeaveService, 'classifyEvents').mockResolvedValue({ rows: [kept, dropped] });
    const persistSpy = jest.spyOn(calendarLeaveService, '_persistRows').mockResolvedValue();
    const importSpy = jest.spyOn(calendarLeaveService, 'importToVacationPulse').mockResolvedValue({ mode: 'shadow', ok: true, counts: { created: 1 } });
    const out = await calendarLeaveService.sync(2, { startDate: '2099-11-01', endDate: '2100-11-01' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].top).toBeGreaterThan(1000);
    expect(importSpy).toHaveBeenCalledWith(2, [kept, dropped], { windowStart: '2099-11-01', windowEnd: '2100-11-01', eventsListed: 2 });
    const written = vtRepo.bulkUpsertLeaves.mock.calls[0][0];
    expect(written.map((r) => r.leaveDate.toISOString().slice(0, 10))).toEqual(['2099-12-01']);
    expect(out.vacationPulse).toEqual({ mode: 'shadow', ok: true, counts: { created: 1 } });
    [fetchSpy, classifySpy, persistSpy, importSpy].forEach((s) => s.mockRestore());
  });
});

describe('reading the calendar', () => {
  test('fetchEvents follows nextLink past 1000 events and asks for sensitivity', async () => {
    prismaMock.calendarLeaveSourceConfig.findUnique.mockResolvedValue({ workspaceId: 2, graphGroupId: 'group-1', timezone: 'America/Vancouver', lookbackDays: 30, horizonDays: 365 });
    const pages = 12;
    let served = 0;
    const queries = [];
    const request = (url) => ({
      header() { return this; },
      query(q) { queries.push(q); return this; },
      async get() {
        const page = served;
        served += 1;
        const value = Array.from({ length: 100 }, (_, i) => ({ id: `e-${page}-${i}`, subject: 'x' }));
        return { value, ...(page + 1 < pages ? { '@odata.nextLink': `${url}&page=${page + 1}` } : {}) };
      },
    });
    calendarLeaveService._graphClient = { api: (url) => request(url) };
    const events = await calendarLeaveService.fetchEvents(2, { startDate: '2099-01-01', endDate: '2099-12-31', top: 10000 });
    expect(events).toHaveLength(1200);
    expect(served).toBe(12);
    expect(queries[0].$select).toContain('sensitivity');
    calendarLeaveService._graphClient = null;
  });
});
