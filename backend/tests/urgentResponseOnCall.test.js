import { jest } from '@jest/globals';

/**
 * Urgent response — on-call (plans/URGENT_RESPONSE_PLAN.md): the 8-week
 * schedule with covers, leave days and "needs cover"; who is on call now;
 * covers; cover requests (first accept wins); the daily "needs cover" check.
 * The on-call person on leave is never skipped — the week is flagged.
 *
 * October 2026 in Vancouver: handover Monday 17:00; Mon 12, 19, 26 Oct.
 */
const TZ = 'America/Vancouver';
const prismaMock = {
  technician: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  holiday: { findMany: jest.fn() },
  urgentResponseOnCallCover: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  urgentResponseCoverRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  urgentResponseAction: { create: jest.fn() },
};
const settingsMock = { getSettings: jest.fn(), timezone: jest.fn(), technicianForEmail: jest.fn() };
const tellPeople = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
// The coordinators for a "needs cover" notice come from the resolver (it reaches into the engine).
const resolveCoordinator = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/groupCoordinatorService.js', () => ({ default: { resolveCoordinator } }));
jest.unstable_mockModule('../src/services/urgentResponse/settingsService.js', () => ({
  default: settingsMock,
  soft: (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback),
}));

const { default: onCall } = await import('../src/services/urgentResponse/onCallService.js');
const { handoverInstant, normalizeSettings } = await import('../src/services/urgentResponse/rules.js');

// The notifier is the engine's file (./notifier.js, imported lazily): stand in for its loader.
const realNotifierLoader = onCall._notifier;
const at = (dateStr, time) => handoverInstant(dateStr, time, TZ);
const PEOPLE = [
  { id: 11, name: 'Andrew Fong', email: 'afong@example.com', isActive: true },
  { id: 22, name: 'Maria Lee', email: 'mlee@example.com', isActive: true },
  { id: 33, name: 'David Zapata', email: 'dzapata@example.com', isActive: true },
  { id: 44, name: 'Gone Person', email: 'gone@example.com', isActive: false },
];
const SETTINGS = normalizeSettings({
  mode: 'observe', onCallOrder: [11, 22, 33], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: '2026-10-12', coordinatorTechnicianId: 33,
});
const WEEK0 = { startsAt: at('2026-10-12', '17:00'), endsAt: at('2026-10-19', '17:00') };
const leave = (technicianId, dateStr, extra = {}) => ({ technicianId, leaveDate: new Date(`${dateStr}T00:00:00Z`), category: 'OFF', status: 'APPROVED', isFullDay: true, ...extra });
const coverRow = (id, extra = {}) => ({
  id, workspaceId: 1, originalTechnicianId: 11, coverTechnicianId: 22, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, note: null, source: 'admin', requestId: null,
  createdBy: 'admin@example.com', createdAt: new Date('2026-10-10T00:00:00Z'), cancelledAt: null, ...extra,
});
const requestRow = (id, extra = {}) => ({
  id, workspaceId: 1, originalTechnicianId: 11, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, message: 'Away that week', status: 'open',
  askedTechnicianIds: [22, 33], responses: [], filledByTechnicianId: null, filledAt: null, createdBy: 'admin@example.com', createdAt: new Date('2026-10-10T00:00:00Z'), ...extra,
});
const ADMIN = { email: 'admin@example.com', name: 'Admin' };
const actions = () => prismaMock.urgentResponseAction.create.mock.calls.map((c) => c[0].data);

beforeEach(() => {
  jest.clearAllMocks();
  onCall._notifier = async () => ({ tellPeople });
  settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...SETTINGS });
  resolveCoordinator.mockResolvedValue({ technicianId: 33, source: 'workspace', notify: [33] });
  settingsMock.timezone.mockResolvedValue(TZ);
  settingsMock.technicianForEmail.mockResolvedValue(null);
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => PEOPLE.filter((p) => where.id.in.includes(p.id)));
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
  prismaMock.holiday.findMany.mockResolvedValue([]);
  prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([]);
  prismaMock.urgentResponseOnCallCover.findFirst.mockResolvedValue(null);
  prismaMock.urgentResponseOnCallCover.create.mockImplementation(async ({ data }) => coverRow(70, data));
  prismaMock.urgentResponseOnCallCover.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.urgentResponseCoverRequest.findMany.mockResolvedValue([]);
  prismaMock.urgentResponseCoverRequest.findFirst.mockResolvedValue(null);
  prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(null);
  prismaMock.urgentResponseCoverRequest.create.mockImplementation(async ({ data }) => requestRow(40, data));
  prismaMock.urgentResponseCoverRequest.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.urgentResponseAction.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  tellPeople.mockResolvedValue({ teams: { sent: 1 }, email: { sent: 1 } });
});

describe('schedule', () => {
  test('eight weeks from the week that holds `from`, in the saved order', async () => {
    const plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00') });
    expect(plan).toMatchObject({ timezone: TZ, handoverDay: 1, handoverTime: '17:00', configured: true, order: [11, 22, 33] });
    expect(plan.weeks).toHaveLength(8);
    expect(plan.weeks.map((w) => w.scheduled.id)).toEqual([11, 22, 33, 11, 22, 33, 11, 22]);
    expect(plan.weeks[0]).toEqual({
      index: 0, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, scheduled: { id: 11, name: 'Andrew Fong' }, covers: [], leaveDays: [], needsCover: false, openRequest: null,
    });
    // The saved order only, never the suggested one.
    expect(settingsMock.getSettings).toHaveBeenCalledWith(1, { suggest: false });
    // Names without photos; every list read is bounded.
    expect(prismaMock.technician.findMany.mock.calls[0][0].select).toEqual({ id: true, name: true, email: true, isActive: true });
    for (const model of ['technician', 'technicianLeave', 'urgentResponseOnCallCover', 'urgentResponseCoverRequest']) {
      expect(prismaMock[model].findMany.mock.calls[0][0].take).toBeGreaterThan(0);
    }
  });

  test('no order saved: not configured, no weeks, no further reads', async () => {
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...normalizeSettings({}) });
    expect(await onCall.schedule(1, { from: at('2026-10-14', '09:00') })).toMatchObject({ configured: false, weeks: [], order: [] });
    expect(prismaMock.urgentResponseOnCallCover.findMany).not.toHaveBeenCalled();
  });

  test('leave of the scheduled person flags the week; other people leave does not', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      leave(11, '2026-10-15'), leave(11, '2026-10-16'),
      leave(11, '2026-10-21'), // Andrew is off in Maria's week: not his problem
      leave(22, '2026-10-22', { category: 'WFH' }),
      leave(33, '2026-10-28', { isFullDay: false, startMinute: 540, endMinute: 780 }),
    ]);
    const plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00'), weeks: 3 });
    expect(plan.weeks.map((w) => [w.leaveDays, w.needsCover])).toEqual([[['2026-10-15', '2026-10-16'], true], [[], false], [[], false]]);
    expect(prismaMock.technicianLeave.findMany.mock.calls[0][0].where).toMatchObject({ technicianId: { in: [11, 22, 33] }, status: 'APPROVED' });
  });

  test('a whole-week cover clears "needs cover"; a part cover leaves the other days', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15'), leave(11, '2026-10-16')]);
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([coverRow(1, { note: 'Swap' })]);
    let plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00'), weeks: 1 });
    expect(plan.weeks[0].needsCover).toBe(false);
    expect(plan.weeks[0].covers).toEqual([{ id: 1, technician: { id: 22, name: 'Maria Lee' }, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, note: 'Swap', source: 'admin' }]);

    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([coverRow(2, { startsAt: at('2026-10-15', '00:00'), endsAt: at('2026-10-16', '00:00') })]);
    plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00'), weeks: 1 });
    expect(plan.weeks[0]).toMatchObject({ leaveDays: ['2026-10-15', '2026-10-16'], needsCover: true });
  });

  test('a leave day that is already over no longer asks for cover; one still running does', async () => {
    // Away Thu 15 and Fri 16; the cover only starts Thursday evening, so most of Thursday had nobody.
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15'), leave(11, '2026-10-16')]);
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([coverRow(3, { startsAt: at('2026-10-15', '20:26'), endsAt: WEEK0.endsAt })]);
    // Thursday afternoon: the gap is now, and it shows.
    let plan = await onCall.schedule(1, { from: at('2026-10-15', '15:00'), weeks: 1 });
    expect(plan.weeks[0]).toMatchObject({ leaveDays: ['2026-10-15', '2026-10-16'], needsCover: true });
    // Saturday: Thursday is history and the rest is covered.
    plan = await onCall.schedule(1, { from: at('2026-10-17', '22:00'), weeks: 1 });
    expect(plan.weeks[0]).toMatchObject({ leaveDays: ['2026-10-15', '2026-10-16'], needsCover: false });
    // The page's days agree with the week.
    const board = await onCall.board(1, { from: at('2026-10-17', '22:00'), weeks: 1 });
    expect(board.weeks[0].needsCover).toBe(false);
    expect(board.days.find((d) => d.date === '2026-10-15')).toMatchObject({ away: true, needsCover: false });
  });

  test('a day away with no cover at all still asks for cover until that day is over', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-16')]);
    expect((await onCall.schedule(1, { from: at('2026-10-16', '23:30'), weeks: 1 })).weeks[0].needsCover).toBe(true);
    expect((await onCall.schedule(1, { from: at('2026-10-17', '00:00'), weeks: 1 })).weeks[0].needsCover).toBe(false);
  });

  test('an open request shows on its week with the asked and declined counts', async () => {
    prismaMock.urgentResponseCoverRequest.findMany.mockResolvedValue([requestRow(7, { askedTechnicianIds: [22, 33, 44, 55], responses: [{ technicianId: 22, answer: 'decline', at: 'x' }] })]);
    const plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(plan.weeks[0].openRequest).toEqual({ id: 7, status: 'open', askedCount: 4, declinedCount: 1 });
    expect(plan.weeks[1].openRequest).toBeNull();
  });

  test('missing tables degrade to an empty schedule of the order', async () => {
    prismaMock.urgentResponseOnCallCover.findMany.mockRejectedValue(new Error('relation does not exist'));
    prismaMock.urgentResponseCoverRequest.findMany.mockRejectedValue(new Error('relation does not exist'));
    const plan = await onCall.schedule(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(plan.weeks.map((w) => w.scheduled.id)).toEqual([11, 22]);
  });
});

describe('board (the /on-call page)', () => {
  const FACES = PEOPLE.map((p) => ({ ...p, photoUrl: `data:image/png;base64,${p.id}`, location: 'Vancouver', timezone: TZ }));
  const withFaces = () => prismaMock.technician.findMany.mockImplementation(async ({ where, select }) => FACES
    .filter((p) => where.id.in.includes(p.id))
    .map((p) => (select.photoUrl ? p : { id: p.id, name: p.name, email: p.email, isActive: p.isActive })));

  test('twelve weeks, each cut into the stretches one person holds, with one face per person', async () => {
    withFaces();
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00') });
    expect(board.weeks).toHaveLength(12);
    expect(board.weeks[0].segments).toEqual([{ technicianId: 11, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, cover: false }]);
    expect(board.order).toEqual([11, 22, 33]);
    expect(Object.keys(board.people).map(Number).sort()).toEqual([11, 22, 33]);
    expect(board.people[11]).toEqual({ id: 11, name: 'Andrew Fong', email: 'afong@example.com', photoUrl: 'data:image/png;base64,11', location: 'Vancouver', timezone: TZ, isActive: true });
    // The photos are read ONCE, by person id, never beside a ticket or a week.
    const photoReads = prismaMock.technician.findMany.mock.calls.filter(([q]) => q.select.photoUrl);
    expect(photoReads).toHaveLength(1);
    expect(photoReads[0][0]).toMatchObject({ where: { workspaceId: 1, id: { in: [11, 22, 33] } }, take: 3 });
  });

  test('one entry per local day: who has the phone that night, and who had it in the morning', async () => {
    withFaces();
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    // Mon 12 Oct 17:00 → Mon 26 Oct 17:00 is fifteen local dates.
    expect(board.days).toHaveLength(15);
    expect(board.days[0]).toEqual({ date: '2026-10-12', technicianId: 11, morningTechnicianId: 11, cover: false, weekIndex: 0, holiday: null, away: false, needsCover: false });
    // The handover day: Andrew in the morning, Maria that night.
    expect(board.days.find((d) => d.date === '2026-10-19')).toMatchObject({ technicianId: 22, morningTechnicianId: 11, weekIndex: 1 });
    expect(board.days[14]).toMatchObject({ date: '2026-10-26', technicianId: 22, morningTechnicianId: 22 });
  });

  test('a cover cuts the week, colours its days, and is the next change of hands', async () => {
    withFaces();
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([
      coverRow(5, { coverTechnicianId: 33, startsAt: at('2026-10-15', '17:00'), endsAt: at('2026-10-17', '17:00') }),
    ]);
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(board.weeks[0].segments).toEqual([
      { technicianId: 11, startsAt: WEEK0.startsAt, endsAt: at('2026-10-15', '17:00'), cover: false },
      { technicianId: 33, startsAt: at('2026-10-15', '17:00'), endsAt: at('2026-10-17', '17:00'), cover: true },
      { technicianId: 11, startsAt: at('2026-10-17', '17:00'), endsAt: WEEK0.endsAt, cover: false },
    ]);
    expect(board.days.find((d) => d.date === '2026-10-15')).toMatchObject({ technicianId: 33, morningTechnicianId: 11, cover: true });
    expect(board.days.find((d) => d.date === '2026-10-16')).toMatchObject({ technicianId: 33, morningTechnicianId: 33, cover: true });
    expect(board.days.find((d) => d.date === '2026-10-17')).toMatchObject({ technicianId: 11, morningTechnicianId: 33, cover: false });
    expect(board.next).toEqual({ technicianId: 33, startsAt: at('2026-10-15', '17:00') });
  });

  test('the week before, and the next handover when nothing else changes', async () => {
    withFaces();
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(board.previous).toEqual({ technicianId: 33, scheduledTechnicianId: 33, startsAt: at('2026-10-05', '17:00'), endsAt: WEEK0.startsAt });
    expect(board.next).toEqual({ technicianId: 22, startsAt: WEEK0.endsAt });
  });

  test('a rotation of one person has no next change of hands', async () => {
    withFaces();
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...SETTINGS, onCallOrder: [11] });
    expect((await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 3 })).next).toBeNull();
  });

  test('holidays of this workspace and the shared ones land on their day; leave days are marked', async () => {
    withFaces();
    prismaMock.holiday.findMany.mockResolvedValue([
      { name: 'Thanksgiving', date: new Date('2026-10-12T00:00:00Z'), isRecurring: false },
      { name: 'Team day', date: new Date('2020-10-20T00:00:00Z'), isRecurring: true },
      { name: 'Long ago', date: new Date('2025-10-13T00:00:00Z'), isRecurring: false },
    ]);
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(board.holidays).toEqual([{ date: '2026-10-12', name: 'Thanksgiving' }, { date: '2026-10-20', name: 'Team day' }]);
    expect(board.days.find((d) => d.date === '2026-10-12').holiday).toBe('Thanksgiving');
    expect(board.days.find((d) => d.date === '2026-10-15')).toMatchObject({ away: true, needsCover: true, holiday: null });
    expect(board.days.find((d) => d.date === '2026-10-16')).toMatchObject({ away: false, needsCover: false });
    expect(prismaMock.holiday.findMany.mock.calls[0][0]).toMatchObject({ where: { isEnabled: true, OR: [{ workspaceId: 1 }, { workspaceId: null }] }, take: 500 });
  });

  test('no order saved: an empty board, and nothing more is read', async () => {
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...normalizeSettings({}) });
    expect(await onCall.board(1, { from: at('2026-10-14', '09:00') })).toMatchObject({
      configured: false, weeks: [], order: [], people: {}, days: [], holidays: [], previous: null, next: null,
    });
    expect(prismaMock.holiday.findMany).not.toHaveBeenCalled();
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
  });

  test('a missing holiday table or photo read degrades to a board without them', async () => {
    prismaMock.holiday.findMany.mockRejectedValue(new Error('relation does not exist'));
    prismaMock.technician.findMany.mockImplementation(async ({ where, select }) => {
      if (select.photoUrl) throw new Error('boom');
      return PEOPLE.filter((p) => where.id.in.includes(p.id));
    });
    const board = await onCall.board(1, { from: at('2026-10-14', '09:00'), weeks: 2 });
    expect(board.people).toEqual({});
    expect(board.holidays).toEqual([]);
    expect(board.weeks.map((w) => w.scheduled.name)).toEqual(['Andrew Fong', 'Maria Lee']);
  });
});

describe('current', () => {
  test('the scheduled person until the handover', async () => {
    const now = await onCall.current(1, at('2026-10-14', '09:00'));
    expect(now).toMatchObject({
      configured: true, timezone: TZ, technician: { id: 11, name: 'Andrew Fong', email: 'afong@example.com' }, scheduled: { id: 11, name: 'Andrew Fong' },
      cover: null, until: WEEK0.endsAt, onLeaveNoCover: false, week: { index: 0, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt },
    });
  });

  test('the handover moves it on at 17:00, not at midnight', async () => {
    expect((await onCall.current(1, at('2026-10-19', '16:59'))).technician.id).toBe(11);
    expect((await onCall.current(1, at('2026-10-19', '17:00'))).technician.id).toBe(22);
  });

  test('a cover in force holds it, until the cover ends', async () => {
    const part = coverRow(2, { startsAt: at('2026-10-15', '00:00'), endsAt: at('2026-10-17', '00:00') });
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([part]);
    const during = await onCall.current(1, at('2026-10-15', '09:00'));
    expect(during).toMatchObject({ technician: { id: 22 }, scheduled: { id: 11 }, until: part.endsAt, onLeaveNoCover: false });
    expect(during.cover).toMatchObject({ id: 2, technician: { id: 22, name: 'Maria Lee' }, original: { id: 11, name: 'Andrew Fong' }, source: 'admin' });
    const before = await onCall.current(1, at('2026-10-14', '09:00'));
    expect(before).toMatchObject({ technician: { id: 11 }, cover: null, until: part.startsAt });
  });

  test('on leave without cover is said, never skipped', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    const now = await onCall.current(1, at('2026-10-15', '20:00'));
    expect(now).toMatchObject({ technician: { id: 11 }, onLeaveNoCover: true });
    expect((await onCall.current(1, at('2026-10-16', '09:00'))).onLeaveNoCover).toBe(false);
    // With a cover in force the leave of the scheduled person is not the question.
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([coverRow(1)]);
    expect(await onCall.current(1, at('2026-10-15', '20:00'))).toMatchObject({ technician: { id: 22 }, onLeaveNoCover: false });
  });

  test('no order saved: not configured', async () => {
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...normalizeSettings({}) });
    expect(await onCall.current(1, at('2026-10-14', '09:00'))).toEqual({
      configured: false, timezone: TZ, technician: null, scheduled: null, cover: null, until: null, onLeaveNoCover: false, week: null,
    });
  });
});

describe('covers', () => {
  const BODY = { originalTechnicianId: 11, coverTechnicianId: 22, startsAt: WEEK0.startsAt.toISOString(), endsAt: WEEK0.endsAt.toISOString(), note: ' Swap ' };

  test('createCover saves it, logs cover_set and tells both people', async () => {
    const cover = await onCall.createCover(1, BODY, ADMIN);
    expect(cover).toEqual({
      id: 70, technician: { id: 22, name: 'Maria Lee' }, original: { id: 11, name: 'Andrew Fong' }, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, note: 'Swap', source: 'admin', requestId: null,
    });
    expect(prismaMock.urgentResponseOnCallCover.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: 1, originalTechnicianId: 11, coverTechnicianId: 22, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, note: 'Swap', source: 'admin', requestId: null, createdBy: 'admin@example.com',
    });
    expect(actions()).toEqual([expect.objectContaining({
      workspaceId: 1, ticketId: null, layer: 'on_call', action: 'cover_set', shadow: false, priority: null, fromTechnicianId: 11, toTechnicianId: 22,
      fromName: 'Andrew Fong', toName: 'Maria Lee', sentence: 'Maria Lee covers on call for Andrew Fong, 12–19 Oct.', dedupeKey: null,
    })]);
    expect(actions()[0].details).toMatchObject({ coverId: 70, source: 'admin', by: 'admin@example.com' });
    expect(tellPeople).toHaveBeenCalledTimes(1);
    expect(tellPeople.mock.calls[0][0]).toMatchObject({
      workspaceId: 1, technicianIds: [22, 11], ticket: null, refKey: 'urgent-cover-set:70', channels: ['teams', 'email'], link: '/on-call',
      title: 'On-call cover: Maria Lee for Andrew Fong, 12–19 Oct',
    });
    expect(tellPeople.mock.calls[0][0].lines).toEqual(['Maria Lee covers on call for Andrew Fong, 12–19 Oct.', 'Note: Swap']);
  });

  test.each([
    ['the same person', { coverTechnicianId: 11 }, 'somebody else'],
    ['an inactive cover', { coverTechnicianId: 44 }, 'active technician'],
    ['a cover from elsewhere', { coverTechnicianId: 999 }, 'active technician'],
    ['an unknown original', { originalTechnicianId: 999 }, 'technician of this workspace'],
    ['no start', { startsAt: null }, 'From'],
    ['a bad end', { endsAt: 'soon' }, 'To'],
    ['an end before the start', { endsAt: '2026-10-01T00:00:00Z' }, 'after the start'],
    ['more than 60 days', { endsAt: '2027-01-20T00:00:00Z' }, 'at most 60 days'],
    ['no cover person', { coverTechnicianId: '' }, 'pick a person'],
  ])('createCover refuses %s', async (_label, patch, message) => {
    await expect(onCall.createCover(1, { ...BODY, ...patch }, ADMIN)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(message) });
    expect(prismaMock.urgentResponseOnCallCover.create).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test('an admin cover may not overlap another one', async () => {
    prismaMock.urgentResponseOnCallCover.findFirst.mockResolvedValue({ id: 3 });
    await expect(onCall.createCover(1, BODY, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(prismaMock.urgentResponseOnCallCover.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: 1, cancelledAt: null, startsAt: { lt: WEEK0.endsAt }, endsAt: { gt: WEEK0.startsAt } });
    expect(prismaMock.urgentResponseOnCallCover.create).not.toHaveBeenCalled();
  });

  test('a notifier that fails, or a log that cannot be written, never fails the cover', async () => {
    tellPeople.mockRejectedValue(new Error('Teams is down'));
    prismaMock.urgentResponseAction.create.mockRejectedValue(new Error('relation does not exist'));
    await expect(onCall.createCover(1, BODY, ADMIN)).resolves.toMatchObject({ id: 70 });
    expect(loggerMock.warn).toHaveBeenCalledTimes(2);
  });

  test('no notifier module at all (the engine is not written yet): the cover still goes in', async () => {
    onCall._notifier = async () => { throw new Error("Cannot find module './notifier.js'"); };
    await expect(onCall.createCover(1, BODY, ADMIN)).resolves.toMatchObject({ id: 70 });
    expect(actions().map((a) => a.action)).toEqual(['cover_set']);
    expect(typeof realNotifierLoader).toBe('function');
  });

  test('cancelCover: this workspace only, and twice is fine', async () => {
    await expect(onCall.cancelCover(1, 5, ADMIN)).rejects.toMatchObject({ statusCode: 404 });
    prismaMock.urgentResponseOnCallCover.findFirst.mockResolvedValue(coverRow(5));
    expect(await onCall.cancelCover(1, 5, ADMIN)).toEqual({ id: 5, cancelled: true });
    expect(prismaMock.urgentResponseOnCallCover.findFirst.mock.calls[1][0].where).toEqual({ id: 5, workspaceId: 1 });
    expect(prismaMock.urgentResponseOnCallCover.updateMany).toHaveBeenCalledWith({ where: { id: 5, cancelledAt: null }, data: { cancelledAt: expect.any(Date) } });
    prismaMock.urgentResponseOnCallCover.updateMany.mockClear();
    prismaMock.urgentResponseOnCallCover.findFirst.mockResolvedValue(coverRow(5, { cancelledAt: new Date() }));
    expect(await onCall.cancelCover(1, 5, ADMIN)).toEqual({ id: 5, cancelled: true });
    expect(prismaMock.urgentResponseOnCallCover.updateMany).not.toHaveBeenCalled();
  });
});

describe('cover requests', () => {
  const BODY = { originalTechnicianId: 11, startsAt: WEEK0.startsAt.toISOString(), endsAt: WEEK0.endsAt.toISOString(), message: 'Away that week' };

  test('createRequest asks the rest of the order, logs cover_requested and tells them with the link', async () => {
    const request = await onCall.createRequest(1, BODY, ADMIN);
    expect(request).toMatchObject({ id: 40, status: 'open', original: { id: 11, name: 'Andrew Fong' }, askedTechnicianIds: [22, 33], askedCount: 2, declinedCount: 0, createdBy: 'admin@example.com' });
    expect(prismaMock.urgentResponseCoverRequest.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: 1, originalTechnicianId: 11, status: 'open', askedTechnicianIds: [22, 33], responses: [], message: 'Away that week', createdBy: 'admin@example.com',
    });
    expect(actions()).toEqual([expect.objectContaining({
      layer: 'on_call', action: 'cover_requested', fromTechnicianId: 11, fromName: 'Andrew Fong', toTechnicianId: null, sentence: 'Cover asked for Andrew Fong, on call 12–19 Oct: 2 people asked.',
    })]);
    expect(tellPeople.mock.calls[0][0]).toMatchObject({
      workspaceId: 1, technicianIds: [22, 33], ticket: null, refKey: 'urgent-cover-request:40', channels: ['teams', 'email'], link: '/on-call?request=40',
      title: 'Andrew Fong needs on-call cover 12–19 Oct. Can you take it?',
    });
  });

  test('askTechnicianIds narrows who is asked; inactive people and the original are left out', async () => {
    await onCall.createRequest(1, { ...BODY, askTechnicianIds: [33, 44, 11, '22'] }, ADMIN);
    expect(prismaMock.urgentResponseCoverRequest.create.mock.calls[0][0].data.askedTechnicianIds).toEqual([33, 22]);
  });

  test('nobody to ask, or a request already open for that window, is refused', async () => {
    await expect(onCall.createRequest(1, { ...BODY, askTechnicianIds: [44] }, ADMIN)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('nobody to ask') });
    prismaMock.urgentResponseCoverRequest.findFirst.mockResolvedValue({ id: 3 });
    await expect(onCall.createRequest(1, BODY, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(prismaMock.urgentResponseCoverRequest.create).not.toHaveBeenCalled();
  });

  test('accept: one guarded update, the cover is created from the request, everyone is told', async () => {
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40));
    settingsMock.technicianForEmail.mockResolvedValue({ id: 33, name: 'David Zapata' });
    const now = new Date('2026-10-11T18:00:00Z');
    const result = await onCall.respond(40, 22, 'accept', { workspaceId: 1, now });
    expect(prismaMock.urgentResponseCoverRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 40, status: 'open' },
      data: { status: 'filled', filledByTechnicianId: 22, filledAt: now, responses: [{ technicianId: 22, answer: 'accept', at: now.toISOString() }] },
    });
    expect(result.status).toBe('filled');
    expect(result.cover).toMatchObject({ id: 70, technician: { id: 22, name: 'Maria Lee' }, original: { id: 11, name: 'Andrew Fong' }, source: 'request', requestId: 40 });
    expect(prismaMock.urgentResponseOnCallCover.create.mock.calls[0][0].data).toMatchObject({ source: 'request', requestId: 40, coverTechnicianId: 22, originalTechnicianId: 11, createdBy: 'mlee@example.com' });
    // A cover that comes from a request is not stopped by an overlap check.
    expect(prismaMock.urgentResponseOnCallCover.findFirst).not.toHaveBeenCalled();
    expect(actions().map((a) => a.action)).toEqual(['cover_set']);
    expect(actions()[0].details).toMatchObject({ requestId: 40, source: 'request' });
    // The cover and the original person, then the admin who asked.
    expect(tellPeople.mock.calls.map((c) => c[0].technicianIds)).toEqual([[22, 11], [33]]);
    expect(tellPeople.mock.calls[1][0].lines).toEqual(['Maria Lee took it.']);
    expect(settingsMock.technicianForEmail).toHaveBeenCalledWith(1, 'admin@example.com');
  });

  test('the second person to accept gets 409 and no cover', async () => {
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40));
    prismaMock.urgentResponseCoverRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(onCall.respond(40, 33, 'accept', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 409, message: 'Somebody else has already taken it' });
    expect(prismaMock.urgentResponseOnCallCover.create).not.toHaveBeenCalled();

    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40, { status: 'filled', filledByTechnicianId: 22 }));
    await expect(onCall.respond(40, 33, 'accept', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 409 });
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40, { status: 'cancelled' }));
    await expect(onCall.respond(40, 33, 'accept', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 409, message: 'This cover request is no longer open' });
  });

  test('decline is recorded and the request stays open; the last decline tells the admin', async () => {
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40));
    settingsMock.technicianForEmail.mockResolvedValue({ id: 33, name: 'David Zapata' });
    const now = new Date('2026-10-11T18:00:00Z');
    expect(await onCall.respond(40, 22, 'decline', { workspaceId: 1, now })).toEqual({ status: 'open', cover: null });
    expect(prismaMock.urgentResponseCoverRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 40, status: 'open' }, data: { responses: [{ technicianId: 22, answer: 'decline', at: now.toISOString() }] },
    });
    expect(tellPeople).not.toHaveBeenCalled();
    expect(prismaMock.urgentResponseOnCallCover.create).not.toHaveBeenCalled();

    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40, { responses: [{ technicianId: 22, answer: 'decline', at: 'x' }] }));
    await onCall.respond(40, 33, 'decline', { workspaceId: 1, now });
    expect(tellPeople).toHaveBeenCalledTimes(1);
    expect(tellPeople.mock.calls[0][0]).toMatchObject({ technicianIds: [33], lines: ['Everyone who was asked said no. The week still needs cover.'] });
  });

  test('respond: only the people asked, only in their workspace, only accept or decline', async () => {
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(requestRow(40));
    await expect(onCall.respond(40, 11, 'accept', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(onCall.respond(40, 22, 'accept', { workspaceId: 2 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(onCall.respond(40, 22, 'maybe', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 400 });
    prismaMock.urgentResponseCoverRequest.findUnique.mockResolvedValue(null);
    await expect(onCall.respond(41, 22, 'accept', { workspaceId: 1 })).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.urgentResponseCoverRequest.updateMany).not.toHaveBeenCalled();
  });

  test('cancelRequest: open ones only', async () => {
    await expect(onCall.cancelRequest(1, 40, ADMIN)).rejects.toMatchObject({ statusCode: 404 });
    prismaMock.urgentResponseCoverRequest.findFirst.mockResolvedValue({ id: 40, status: 'open' });
    expect(await onCall.cancelRequest(1, 40, ADMIN)).toEqual({ id: 40, status: 'cancelled' });
    expect(prismaMock.urgentResponseCoverRequest.updateMany).toHaveBeenCalledWith({ where: { id: 40, status: 'open' }, data: { status: 'cancelled' } });
    prismaMock.urgentResponseCoverRequest.findFirst.mockResolvedValue({ id: 40, status: 'filled' });
    prismaMock.urgentResponseCoverRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(onCall.cancelRequest(1, 40, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('requestsFor: open, addressed to me, not answered yet', async () => {
    prismaMock.urgentResponseCoverRequest.findMany.mockResolvedValue([
      requestRow(40),
      requestRow(41, { responses: [{ technicianId: 22, answer: 'decline', at: 'x' }] }),
      requestRow(42, { originalTechnicianId: 33, responses: [{ technicianId: 33, answer: 'decline', at: 'x' }] }),
    ]);
    const now = new Date('2026-10-11T18:00:00Z');
    const mine = await onCall.requestsFor(22, { workspaceId: 1, now });
    expect(mine).toEqual([
      { id: 40, original: { id: 11, name: 'Andrew Fong' }, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, message: 'Away that week', createdBy: 'admin@example.com' },
      { id: 42, original: { id: 33, name: 'David Zapata' }, startsAt: WEEK0.startsAt, endsAt: WEEK0.endsAt, message: 'Away that week', createdBy: 'admin@example.com' },
    ]);
    expect(prismaMock.urgentResponseCoverRequest.findMany.mock.calls[0][0]).toMatchObject({
      where: { workspaceId: 1, status: 'open', askedTechnicianIds: { has: 22 }, endsAt: { gt: now } }, take: 20,
    });
    expect(await onCall.requestsFor(null)).toEqual([]);
  });
});

describe('dailyCoverCheck', () => {
  const NOW = at('2026-10-13', '09:00');

  test('leave without cover or request: logged once with a dedupe key, the coordinator is told', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15'), leave(22, '2026-10-21')]);
    const out = await onCall.dailyCoverCheck(1, NOW);
    expect(out).toEqual({
      checked: 2, expired: 1,
      flagged: [{ weekIndex: 0, technicianId: 11, leaveDays: ['2026-10-15'] }, { weekIndex: 1, technicianId: 22, leaveDays: ['2026-10-21'] }],
    });
    expect(actions().map((a) => [a.action, a.layer, a.fromTechnicianId, a.dedupeKey])).toEqual([
      ['cover_needed', 'on_call', 11, 'cover_needed:1:2026-10-12:2026-10-13'],
      ['cover_needed', 'on_call', 22, 'cover_needed:1:2026-10-19:2026-10-13'],
    ]);
    expect(actions()[0].sentence).toBe('Andrew Fong is on call 12–19 Oct and has leave on Thu 15 Oct. The week needs cover.');
    expect(tellPeople).toHaveBeenCalledTimes(2);
    expect(tellPeople.mock.calls[0][0]).toMatchObject({ technicianIds: [33], refKey: 'urgent-cover-needed:1:0:2026-10-13', ticket: null });
    expect(resolveCoordinator).toHaveBeenCalledWith({ workspaceId: 1, groupId: null, group: null, at: NOW });
    // Requests whose window has passed are closed.
    expect(prismaMock.urgentResponseCoverRequest.updateMany).toHaveBeenCalledWith({ where: { workspaceId: 1, status: 'open', endsAt: { lt: NOW } }, data: { status: 'expired' } });
  });

  test('already said today (dedupe key exists): nobody is told again', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    prismaMock.urgentResponseAction.create.mockRejectedValue(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    const out = await onCall.dailyCoverCheck(1, NOW);
    expect(out.flagged).toEqual([]);
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test('a cover, or an open request, means nothing to flag', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([coverRow(1)]);
    expect((await onCall.dailyCoverCheck(1, NOW)).flagged).toEqual([]);
    prismaMock.urgentResponseOnCallCover.findMany.mockResolvedValue([]);
    prismaMock.urgentResponseCoverRequest.findMany.mockResolvedValue([requestRow(7)]);
    expect((await onCall.dailyCoverCheck(1, NOW)).flagged).toEqual([]);
    expect(prismaMock.urgentResponseAction.create).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test('workspace coordinators in mode "all": every one of them is told, the owner first', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    resolveCoordinator.mockResolvedValue({ technicianId: 22, source: 'workspace', notify: [22, 33], mode: 'all' });
    await onCall.dailyCoverCheck(1, NOW);
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([22, 33]);
    expect(actions()[0].details).toMatchObject({ toldTechnicianId: 22, toldTechnicianIds: [22, 33] });
  });

  test('no coordinator: the "nobody at work" contact is told instead; a failing resolver is "nobody"', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    resolveCoordinator.mockResolvedValue({ technicianId: null, source: null, notify: [] });
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...SETTINGS, coordinatorTechnicianId: null, nobodyContactTechnicianId: 11 });
    await onCall.dailyCoverCheck(1, NOW);
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([11]);

    jest.clearAllMocks();
    resolveCoordinator.mockRejectedValue(new Error('engine away'));
    await onCall.dailyCoverCheck(1, NOW);
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([11]);
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('engine away'));
  });

  test('no coordinator: still logged, nobody to tell; no order: nothing at all; never throws', async () => {
    prismaMock.technicianLeave.findMany.mockResolvedValue([leave(11, '2026-10-15')]);
    resolveCoordinator.mockResolvedValue({ technicianId: null, source: null, notify: [] });
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...SETTINGS, coordinatorTechnicianId: null });
    expect((await onCall.dailyCoverCheck(1, NOW)).flagged).toHaveLength(1);
    expect(tellPeople).not.toHaveBeenCalled();

    jest.clearAllMocks();
    settingsMock.getSettings.mockResolvedValue({ workspaceId: 1, ...normalizeSettings({}) });
    expect(await onCall.dailyCoverCheck(1, NOW)).toMatchObject({ checked: 0, flagged: [] });
    expect(prismaMock.urgentResponseAction.create).not.toHaveBeenCalled();

    settingsMock.getSettings.mockRejectedValue(new Error('database is away'));
    await expect(onCall.dailyCoverCheck(1, NOW)).resolves.toMatchObject({ checked: 0, flagged: [] });
  });
});
