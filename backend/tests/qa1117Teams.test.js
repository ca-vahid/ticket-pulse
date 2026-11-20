import { jest } from '@jest/globals';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * QA 11-17 #2, #3, #4: more than one digest a day, the on-call start notice,
 * and survey results in Teams. Names are invented.
 */

const prismaMock = {
  notificationWorkspaceSetting: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
  notificationPreference: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}), findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  ticketNotificationMute: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
  teamsDelivery: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  teamsConversation: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  technicianLeave: { findFirst: jest.fn().mockResolvedValue(null) },
  technicianNotificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  ticket: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ nativeTicketingEnabled: true, name: 'Facilities' }) },
};
const botMock = {
  isTeamsConfigured: jest.fn(() => true),
  teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
  sendToConversation: jest.fn().mockResolvedValue('act-1'),
  cardActivity: jest.fn((card, o) => ({ type: 'message', card, ...o })),
  sendActivityFeed: jest.fn().mockResolvedValue(),
  findUser: jest.fn(),
  installForUser: jest.fn(),
  createPersonalConversation: jest.fn(),
  describeError: (e) => e.message,
};
const scheduleMock = jest.fn();
const currentMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { statusNamesForBase: jest.fn().mockResolvedValue(['Open', 'Pending']) } }));
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: { schedule: scheduleMock, current: currentMock } }));

const slots = await import('../src/services/teamsDigestSlots.js');
const { default: svc, EVENTS, cleanPrefs, effectivePrefs, offeredEvents } = await import('../src/services/teamsNotificationService.js');
const { default: extras, onCallPeriodStarting, onCallSentence, surveyAudience } = await import('../src/services/teamsExtraNotices.js');
const { onCallStartCard, surveyResultCard, digestCard } = await import('../src/services/teamsCards.js');

const PT = 'America/Vancouver';
const at = (date, time) => slots.zonedInstant(date, time, PT);
const ptClock = (d) => formatInTimeZone(d, PT, 'yyyy-MM-dd HH:mm');

const DANA = { id: 7, name: 'Dana Fox', email: 'dana.fox@example.com', timezone: PT, workStartTime: '09:00', workEndTime: '17:00', workspaceId: 3 };
const ELI = { id: 12, name: 'Eli Park', email: 'eli.park@example.com', timezone: PT, workStartTime: null, workEndTime: null, workspaceId: 3 };
const wsRow = (extrasObj = {}, options = {}) => ({ workspaceId: 3, teamsEnabled: true, defaults: { events: {}, options, extras: extrasObj } });

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.teamsDelivery.create.mockResolvedValue({});
  prismaMock.teamsDelivery.findMany.mockResolvedValue([]);
  prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
  prismaMock.notificationPreference.update.mockResolvedValue({});
  prismaMock.notificationPreference.upsert.mockResolvedValue({});
  prismaMock.notificationWorkspaceSetting.upsert.mockResolvedValue({});
  prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
  prismaMock.ticketNotificationMute.findUnique.mockResolvedValue(null);
  prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue(null);
  prismaMock.technicianLeave.findFirst.mockResolvedValue(null);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.count.mockResolvedValue(0);
  prismaMock.teamsConversation.findUnique.mockImplementation(async ({ where }) => ({ email: where.email, conversationId: `conv-${where.email}`, serviceUrl: 'https://smba.example.com/', aadObjectId: `aad-${where.email}` }));
  botMock.isTeamsConfigured.mockReturnValue(true);
  botMock.sendToConversation.mockResolvedValue('act-1');
});

// ------------------------------------------------------------------ #2 schedule maths

describe('digest times: schedule maths (Pacific, DST-safe)', () => {
  test('labels are plain "9:00 AM PT"', () => {
    expect(slots.timeLabel('09:00')).toBe('9:00 AM PT');
    expect(slots.timeLabel('15:00')).toBe('3:00 PM PT');
    expect(slots.timeLabel('00:30')).toBe('12:30 AM PT');
    expect(slots.timeLabel('12:00')).toBe('12:00 PM PT');
    expect(slots.timeLabel('25:00')).toBe('');
  });

  test('the workspace list keeps the daily time first and at most three extras', () => {
    expect(slots.workspaceDigestTimes('09:00', ['15:00', '09:00', 'bad', '07:00', '18:00', '20:00'])).toEqual(['09:00', '07:00', '15:00', '18:00']);
    expect(slots.workspaceDigestTimes(undefined, undefined)).toEqual(['08:00']);
  });

  test.each([
    ['winter', '2026-01-14'],
    ['the day after the spring change', '2026-03-09'],
    ['summer', '2026-07-15'],
    ['the day after the autumn change', '2026-11-02'],
  ])('a 3:00 PM PT slot is 15:00 on the Vancouver clock in %s', (_name, date) => {
    const now = at(date, '15:05');
    const list = slots.digestSlotsFor({ now, firstTime: '09:00', firstTz: PT, extras: ['15:00'] }).filter((s) => !s.stale);
    expect(list.map((s) => ptClock(s.at))).toEqual([`${date} 09:00`, `${date} 15:00`]);
    expect(list.map((s) => s.label)).toEqual(['9:00 AM PT', '3:00 PM PT']);
  });

  test('a first time in another zone stays in that zone; the extra stays Pacific', () => {
    const now = at('2026-07-15', '15:05');
    const list = slots.digestSlotsFor({ now, firstTime: '08:00', firstTz: 'America/Toronto', extras: ['15:00'] }).filter((s) => !s.stale);
    expect(formatInTimeZone(list[0].at, 'America/Toronto', 'HH:mm')).toBe('08:00');
    expect(ptClock(list[1].at)).toBe('2026-07-15 15:00');
  });

  test('due: the latest passed slot after the last digest; one digest even when several were missed', () => {
    const now = at('2026-07-15', '15:05');
    const list = slots.digestSlotsFor({ now, firstTime: '09:00', extras: ['12:00', '15:00'] });
    expect(slots.dueDigestSlot({ slots: list, lastDigestAt: at('2026-07-15', '09:03'), now }).time).toBe('15:00');
    expect(slots.dueDigestSlot({ slots: list, lastDigestAt: null, now }).time).toBe('15:00');
    expect(slots.dueDigestSlot({ slots: list, lastDigestAt: at('2026-07-15', '09:03'), now: at('2026-07-15', '11:59') })).toBeNull();
  });

  test('dedupe: once the 3 PM digest went out, nothing is due until tomorrow (survives a restart: it is the stored column)', () => {
    const last = at('2026-07-15', '15:06');
    for (const t of ['15:16', '18:00', '23:59']) {
      const now = at('2026-07-15', t);
      const list = slots.digestSlotsFor({ now, firstTime: '09:00', extras: ['15:00'] });
      expect(slots.dueDigestSlot({ slots: list, lastDigestAt: last, now })).toBeNull();
    }
    const tomorrow = at('2026-07-16', '09:04');
    const list = slots.digestSlotsFor({ now: tomorrow, firstTime: '09:00', extras: ['15:00'] });
    expect(slots.dueDigestSlot({ slots: list, lastDigestAt: last, now: tomorrow }).time).toBe('09:00');
  });

  test('previous: the earlier digest the same day, never yesterday', () => {
    const now = at('2026-07-15', '15:05');
    const list = slots.digestSlotsFor({ now, firstTime: '09:00', extras: ['15:00'] });
    const due = slots.dueDigestSlot({ slots: list, lastDigestAt: at('2026-07-15', '09:03'), now });
    expect(slots.previousDigestSlot({ slots: list, lastDigestAt: at('2026-07-15', '09:03'), due }).label).toBe('9:00 AM PT');
    expect(slots.previousDigestSlot({ slots: list, lastDigestAt: at('2026-07-14', '15:04'), due })).toBeNull();
    expect(slots.previousDigestSlot({ slots: list, lastDigestAt: null, due })).toBeNull();
    expect(slots.planDigest({ slots: list, lastDigestAt: at('2026-07-15', '09:03'), now })).toMatchObject({ sinceLabel: 'Since your 9:00 AM PT digest' });
    expect(slots.planDigest({ slots: list, lastDigestAt: at('2026-07-14', '15:04'), now })).toMatchObject({ sinceLabel: null });
  });

  // Fix 2: the old rule never sent a second full digest on one day.
  test('moving my time after today\'s digest went out does not send a second full digest', () => {
    const last = at('2026-07-15', '08:05');
    const now = at('2026-07-15', '10:05');
    const list = slots.digestSlotsFor({ now, firstTime: '10:00' });
    expect(slots.planDigest({ slots: list, lastDigestAt: last, now })).toMatchObject({ skip: 'already_today' });
    // An extra time later that day still comes, as "since" the 8:05 digest.
    const later = at('2026-07-15', '15:05');
    const withExtra = slots.digestSlotsFor({ now: later, firstTime: '10:00', extras: ['15:00'] });
    expect(slots.planDigest({ slots: withExtra, lastDigestAt: last, now: later })).toMatchObject({ due: { time: '15:00' }, sinceLabel: 'Since your 8:05 AM PT digest' });
    // Tomorrow the 10:00 digest is the full one again.
    const tomorrow = at('2026-07-16', '10:05');
    expect(slots.planDigest({ slots: slots.digestSlotsFor({ now: tomorrow, firstTime: '10:00' }), lastDigestAt: last, now: tomorrow })).toMatchObject({ due: { time: '10:00' }, sinceLabel: null });
  });

  // Fix 3: late slots and weekends.
  test('a 23:55 PT slot missed by the tick is still sent at 00:02, but not hours later', () => {
    const last = at('2026-07-15', '09:03');
    const justAfter = at('2026-07-16', '00:02');
    const list = slots.digestSlotsFor({ now: justAfter, firstTime: '09:00', extras: ['23:55'] });
    const plan = slots.planDigest({ slots: list, lastDigestAt: last, now: justAfter });
    expect(plan.due).toMatchObject({ time: '23:55', date: '2026-07-15' });
    expect(plan.sinceLabel).toBe('Since your 9:00 AM PT digest');
    const late = at('2026-07-16', '07:00');
    expect(slots.planDigest({ slots: slots.digestSlotsFor({ now: late, firstTime: '09:00', extras: ['23:55'] }), lastDigestAt: last, now: late })).toBeNull();
  });

  test('weekends are judged in each slot\'s own zone', () => {
    // Friday 22:00 PT is Saturday in Toronto: the Pacific extra still goes.
    const fri = at('2026-11-20', '22:05');
    const friSlots = slots.digestSlotsFor({ now: fri, firstTime: '08:00', firstTz: 'America/Toronto', extras: ['22:00'] });
    expect(slots.dueDigestSlot({ slots: friSlots, lastDigestAt: at('2026-11-20', '05:05'), now: fri })).toMatchObject({ time: '22:00', date: '2026-11-20' });
    // Sunday 22:00 PT is Monday in Toronto: the Pacific extra does not go.
    const sun = at('2026-11-22', '22:05');
    const sunSlots = slots.digestSlotsFor({ now: sun, firstTime: '08:00', firstTz: 'America/Toronto', extras: ['22:00'] });
    expect(sunSlots.map((s) => s.time)).not.toContain('22:00');
    expect(slots.dueDigestSlot({ slots: sunSlots, lastDigestAt: at('2026-11-20', '22:05'), now: sun })).toBeNull();
    // Monday 8:00 in Toronto comes on time (05:00 PT).
    const mon = at('2026-11-23', '05:10');
    const monSlots = slots.digestSlotsFor({ now: mon, firstTime: '08:00', firstTz: 'America/Toronto', extras: ['22:00'] });
    expect(slots.dueDigestSlot({ slots: monSlots, lastDigestAt: at('2026-11-20', '22:05'), now: mon })).toMatchObject({ time: '08:00', first: true, tz: 'America/Toronto' });
  });

  test('only extra times the workspace still offers count', () => {
    expect(slots.optedExtraTimes(['08:00', '15:00'], ['15:00', '18:00', '08:00'])).toEqual(['15:00']);
  });

  test('the "since" summary says what is new, in words', () => {
    const held = [{ eventKey: 'group_unassigned' }, { eventKey: 'group_unassigned' }, { eventKey: 'group_unassigned' }, { eventKey: 'requester_replied' }];
    expect(slots.sinceSummary({ held, newCount: 2 })).toBe('3 new unassigned tickets · 2 tickets assigned to you · 1 other update');
    expect(slots.sinceSummary({ held: [{ eventKey: 'group_unassigned' }], newCount: 0 })).toBe('1 new unassigned ticket');
  });
});

// ------------------------------------------------------------------ #2 the runner

describe('digest times: the runner', () => {
  const prefRow = (options = {}, events = { group_unassigned: 'digest' }, lastDigestAt = null) => ({ id: 55, workspaceId: 3, technicianId: 7, events, options, lastDigestAt });
  const setup = ({ row, extrasObj = { digestTimes: ['15:00'] }, held = [] }) => {
    prismaMock.notificationPreference.findMany.mockResolvedValue([row]);
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow(extrasObj, { digestTime: '09:00' }));
    prismaMock.technician.findUnique.mockResolvedValue(DANA);
    prismaMock.technician.findMany.mockResolvedValue([{ id: 7, name: 'Dana Fox', workspaceId: 3, timezone: PT }]);
    prismaMock.teamsDelivery.findMany.mockResolvedValue(held);
  };
  const UNASSIGNED = [1, 2, 3].map((n) => ({ eventKey: 'group_unassigned', summary: `#9${n} Ladder inspection ${n}` }));

  test('3 PM PT, opted in, 9 AM digest earlier: only what is new, said so in the banner', async () => {
    setup({ row: prefRow({ digestSlots: ['15:00'] }, { group_unassigned: 'digest' }, at('2026-07-15', '09:03')), held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '15:05'));
    expect(botMock.sendToConversation).toHaveBeenCalledTimes(1);
    const card = botMock.cardActivity.mock.calls[0][0];
    const json = JSON.stringify(card);
    expect(json).toContain('Since your 9:00 AM PT digest');
    expect(json).toContain('**Since your 9:00 AM PT digest:** 3 new unassigned tickets');
    expect(json).toContain('HELD SINCE THEN');
    expect(prismaMock.teamsDelivery.findMany.mock.calls[0][0].where).toMatchObject({ status: 'digest', createdAt: { gt: at('2026-07-15', '09:03') } });
    expect(prismaMock.notificationPreference.update).toHaveBeenCalledWith({ where: { id: 55 }, data: { lastDigestAt: at('2026-07-15', '15:05') } });
  });

  test('not opted in: the 3 PM time does nothing, today\'s single digest stays as it was', async () => {
    setup({ row: prefRow({}, { group_unassigned: 'digest' }, at('2026-07-15', '09:03')), held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '15:05'));
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    expect(prismaMock.notificationPreference.update).not.toHaveBeenCalled();
  });

  test('no earlier digest today: the 3 PM digest is the full digest', async () => {
    setup({ row: prefRow({ digestSlots: ['15:00'] }, { group_unassigned: 'digest' }, at('2026-07-14', '15:04')), held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '15:05'));
    const json = JSON.stringify(botMock.cardActivity.mock.calls[0][0]);
    expect(json).toContain('Your tickets today, Dana');
    expect(json).not.toContain('Since your');
  });

  test('nothing new since 9 AM: no card, a "nothing_new" row, and the slot is used up', async () => {
    setup({ row: prefRow({ digestSlots: ['15:00'] }, { group_unassigned: 'digest' }, at('2026-07-15', '09:03')), held: [] });
    await svc.runDigests(at('2026-07-15', '15:05'));
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'nothing_new', eventKey: 'digest' }) });
    expect(prismaMock.notificationPreference.update).toHaveBeenCalled();
  });

  test('already sent at 3:05 PM: the next ticks send nothing', async () => {
    setup({ row: prefRow({ digestSlots: ['15:00'] }, { group_unassigned: 'digest' }, at('2026-07-15', '15:05')), held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '15:15'));
    await svc.runDigests(at('2026-07-15', '17:45'));
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
  });

  test('fix 2: no extra times, 8:00 digest sent, time moved to 10:00: no second digest that day', async () => {
    setup({ row: prefRow({ digestTime: '10:00' }, { group_unassigned: 'digest' }, at('2026-07-15', '08:05')), extrasObj: {}, held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '10:05'));
    await svc.runDigests(at('2026-07-15', '16:00'));
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    expect(prismaMock.notificationPreference.update).not.toHaveBeenCalled();
    await svc.runDigests(at('2026-07-16', '10:05'));
    expect(botMock.sendToConversation).toHaveBeenCalledTimes(1);
  });

  test('a time the admin removed is ignored even if the person had it on', async () => {
    setup({ row: prefRow({ digestSlots: ['15:00'] }, { group_unassigned: 'digest' }, at('2026-07-15', '09:03')), extrasObj: { digestTimes: [] }, held: UNASSIGNED });
    await svc.runDigests(at('2026-07-15', '15:05'));
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ #2/#3/#4 prefs and settings

describe('prefs and workspace settings', () => {
  test('new rows: on-call Teams/Off only, behind a workspace switch; survey results always offered (QA 11-19 #1)', () => {
    expect(EVENTS.find((e) => e.key === 'survey_result')).toMatchObject({ mode: 'teams' });
    expect(EVENTS.find((e) => e.key === 'survey_result').offeredBy).toBeUndefined();
    expect(EVENTS.find((e) => e.key === 'on_call_start')).toMatchObject({ mode: 'teams', modes: ['teams', 'off'], offeredBy: 'onCallNotice' });
    expect(offeredEvents({}).map((e) => e.key)).toContain('survey_result');
    expect(offeredEvents({}).map((e) => e.key)).not.toContain('on_call_start');
    expect(offeredEvents({ onCallNotice: true, surveyResults: true }).map((e) => e.key)).toEqual(expect.arrayContaining(['survey_result', 'on_call_start']));
  });

  test('on-call has no Digest; extra digest times and survey scope are personal only', () => {
    expect(cleanPrefs({ events: { on_call_start: 'digest', survey_result: 'digest' } }).events).toEqual({ survey_result: 'digest' });
    expect(effectivePrefs(null, { events: { on_call_start: 'digest' } }).events.on_call_start).toBe('teams');
    expect(cleanPrefs({ options: { digestSlots: ['15:00', 'x', '15:00', '09:00'], surveyScope: 'all' } }, { personal: true }).options)
      .toEqual({ digestSlots: ['09:00', '15:00'], surveyScope: 'all' });
    expect(cleanPrefs({ options: { digestSlots: ['15:00'], surveyScope: 'all' } }).options).toEqual({});
    expect(effectivePrefs({ options: { digestSlots: ['15:00'], surveyScope: 'all' } }, null).options).toMatchObject({ digestSlots: [], surveyScope: 'mine' });
  });

  test('digest times save: the first is the daily default, extras sorted; nothing changes for anyone by default', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 3, teamsEnabled: true, defaults: null });
    expect((await svc.workspaceSettings(3))).toMatchObject({ digestTimes: ['08:00'], onCallNotice: false, surveyResults: false });
    await svc.saveWorkspaceSettings(3, { digestTimes: ['08:00', '15:00', '09:00'], onCallNotice: true, surveyResults: true });
    const saved = prismaMock.notificationWorkspaceSetting.upsert.mock.calls[0][0].update.defaults;
    expect(saved.options.digestTime).toBe('08:00');
    expect(saved.extras).toEqual({ digestTimes: ['09:00', '15:00'], onCallNotice: true, surveyResults: true });
  });

  test('digest times are checked', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 3, teamsEnabled: true, defaults: null });
    await expect(svc.saveWorkspaceSettings(3, { digestTimes: ['08:00', '09:00', '10:00', '11:00', '12:00'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.saveWorkspaceSettings(3, { digestTimes: ['8am'] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.saveWorkspaceSettings(3, { digestTimes: [] })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('saving defaults later keeps the extras', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ digestTimes: ['15:00'], onCallNotice: true }, { digestTime: '09:00' }));
    await svc.saveWorkspaceSettings(3, { defaults: { events: { assigned: 'digest' }, options: { digestTime: '09:00' } } });
    expect(prismaMock.notificationWorkspaceSetting.upsert.mock.calls[0][0].update.defaults.extras).toEqual({ digestTimes: ['15:00'], onCallNotice: true });
  });

  test('"Everyone\'s" survey results are kept only for those who may choose them', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...DANA });
    const statusSpy = jest.spyOn(svc, 'myStatus').mockResolvedValue({ ok: true });
    const roleSpy = jest.spyOn(svc, '_canSeeAllSurveys').mockResolvedValue(false);
    await svc.saveMyPrefs(DANA.email, 3, { events: { survey_result: 'teams' }, options: { surveyScope: 'all', digestSlots: ['15:00'] } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[0][0].update.options).toEqual({ digestSlots: ['15:00'] });
    roleSpy.mockResolvedValue(true);
    await svc.saveMyPrefs(DANA.email, 3, { options: { surveyScope: 'all' } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[1][0].update.options).toEqual({ surveyScope: 'all' });
    techSpy.mockRestore(); statusSpy.mockRestore(); roleSpy.mockRestore();
  });

  // Fix 1: the panel sends only the rows it shows; a save never wipes the rest.
  test('saving merges: hidden rows and a stored "Everyone\'s" survive', async () => {
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...DANA });
    const statusSpy = jest.spyOn(svc, 'myStatus').mockResolvedValue({ ok: true });
    const roleSpy = jest.spyOn(svc, '_canSeeAllSurveys').mockRejectedValue(new Error('role lookup down'));
    prismaMock.notificationPreference.findUnique.mockResolvedValue({
      events: { on_call_start: 'off', survey_result: 'digest', assigned: 'teams' },
      options: { surveyScope: 'all', digestSlots: ['15:00'], respectAway: true },
    });
    // Both switches are off for a while: the panel shows neither row.
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}));
    await svc.saveMyPrefs(DANA.email, 3, { events: { assigned: 'digest' }, options: { surveyScope: 'mine', respectAway: false } });
    const saved = prismaMock.notificationPreference.upsert.mock.calls[0][0].update;
    expect(saved.events).toEqual({ on_call_start: 'off', survey_result: 'digest', assigned: 'digest' });
    expect(saved.options).toEqual({ surveyScope: 'all', digestSlots: ['15:00'], respectAway: false });
    // Survey switch on, but the role check fails: still kept.
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
    await svc.saveMyPrefs(DANA.email, 3, { options: { surveyScope: 'mine' } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[1][0].update.options.surveyScope).toBe('all');
    // An admin who can choose may switch back to Mine.
    roleSpy.mockResolvedValue(true);
    await svc.saveMyPrefs(DANA.email, 3, { options: { surveyScope: 'mine' } });
    expect(prismaMock.notificationPreference.upsert.mock.calls[2][0].update.options.surveyScope).toBe('mine');
    techSpy.mockRestore(); statusSpy.mockRestore(); roleSpy.mockRestore();
  });

  test('my status lists the offered rows, the digest times and whether I may pick everyone\'s', async () => {
    const techSpy = jest.spyOn(svc, '_tech').mockResolvedValue({ ...DANA });
    const roleSpy = jest.spyOn(svc, '_canSeeAllSurveys').mockResolvedValue(true);
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ digestTimes: ['15:00'], onCallNotice: true, surveyResults: true }, { digestTime: '09:00' }));
    const me = await svc.myStatus(DANA.email, 3);
    expect(me.digestTimes).toEqual(['09:00', '15:00']);
    expect(me.surveyScopeChoice).toBe(true);
    expect(me.events.find((e) => e.key === 'on_call_start')).toMatchObject({ mode: 'teams', modes: ['teams', 'off'] });
    expect(me.events.find((e) => e.key === 'survey_result')).toMatchObject({ mode: 'teams', workspaceDefault: 'teams' });
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}, {}));
    roleSpy.mockClear();
    const plain = await svc.myStatus(DANA.email, 3);
    expect(plain.events.map((e) => e.key)).not.toEqual(expect.arrayContaining(['on_call_start']));
    // QA 11-19 #1: the survey row stays (own tickets); only the choice goes.
    expect(plain.events.map((e) => e.key)).toContain('survey_result');
    expect(plain.surveyScopeChoice).toBe(false);
    expect(roleSpy).not.toHaveBeenCalled();
    techSpy.mockRestore(); roleSpy.mockRestore();
  });
});

// ------------------------------------------------------------------ #3 on call

describe('on-call start', () => {
  // A Monday 5:00 PM PT rotation (the IT week).
  const WEEK = { startsAt: at('2026-11-16', '17:00'), endsAt: at('2026-11-23', '17:00'), technicianId: 7 };

  test('the period starts at the handover; a few hours later it is no longer "starting"', () => {
    expect(onCallPeriodStarting({ week: WEEK, now: at('2026-11-16', '16:59') })).toBeNull();
    expect(onCallPeriodStarting({ week: WEEK, now: at('2026-11-16', '17:10') })).toMatchObject({ technicianId: 7, fullWeek: true });
    expect(onCallPeriodStarting({ week: WEEK, now: at('2026-11-16', '19:55') })).toMatchObject({ technicianId: 7 });
    expect(onCallPeriodStarting({ week: WEEK, now: at('2026-11-16', '20:05') })).toBeNull();
    expect(onCallPeriodStarting({ week: WEEK, now: at('2026-11-18', '12:00') })).toBeNull();
  });

  test('a cover gets their own start; the scheduled person is not told again when it ends', () => {
    const covers = [{ id: 1, coverTechnicianId: 12, startsAt: at('2026-11-18', '09:00'), endsAt: at('2026-11-19', '09:00') }];
    expect(onCallPeriodStarting({ week: WEEK, covers, now: at('2026-11-18', '09:05') })).toMatchObject({ technicianId: 12, fullWeek: false, cover: true });
    expect(onCallPeriodStarting({ week: WEEK, covers, now: at('2026-11-19', '09:05') })).toBeNull();
  });

  test('a cover from the handover: the scheduled person is told when they take over', () => {
    const covers = [{ id: 2, coverTechnicianId: 12, startsAt: at('2026-11-16', '17:00'), endsAt: at('2026-11-17', '17:00') }];
    expect(onCallPeriodStarting({ week: WEEK, covers, now: at('2026-11-16', '17:05') })).toMatchObject({ technicianId: 12 });
    expect(onCallPeriodStarting({ week: WEEK, covers, now: at('2026-11-17', '17:05') })).toMatchObject({ technicianId: 7, fullWeek: false });
  });

  test('the sentence and the card', () => {
    const period = { startsAt: WEEK.startsAt, endsAt: WEEK.endsAt, fullWeek: true };
    const sentence = onCallSentence(period, PT);
    expect(sentence).toBe("You're on call for after-hours support this week, Mon 16 Nov 5:00 PM PT to Mon 23 Nov 5:00 PM PT.");
    expect(onCallSentence({ ...period, fullWeek: false }, PT)).toMatch(/^You're on call for after-hours support from Mon 16 Nov 5:00 PM PT to/);
    const card = onCallStartCard({ sentence, url: 'https://tp.example.com/on-call' });
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.5', actions: [{ type: 'Action.OpenUrl', title: 'Open the on-call page', url: 'https://tp.example.com/on-call' }] });
    expect(card.body[1]).toMatchObject({ type: 'TextBlock', text: sentence });
    expect(JSON.stringify(card.body[0])).toContain('On call');
  });

  describe('the runner', () => {
    const plan = (over = {}) => ({ configured: true, timezone: PT, weeks: [{ startsAt: WEEK.startsAt, endsAt: WEEK.endsAt, scheduled: { id: 7, name: 'Dana Fox' }, covers: [] }], ...over });
    beforeEach(() => {
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ onCallNotice: true }));
      prismaMock.technician.findFirst.mockResolvedValue(DANA);
      scheduleMock.mockResolvedValue(plan());
      // Right before the handover somebody else held it.
      currentMock.mockResolvedValue({ configured: true, technician: { id: 12, name: 'Eli Park' } });
    });

    // Fix 4: B covers Sunday to Tuesday across the Monday 5 PM handover.
    test('the same person right before the period: one continuous stretch, no second message', async () => {
      currentMock.mockResolvedValue({ configured: true, technician: { id: 7, name: 'Dana Fox' } });
      scheduleMock.mockResolvedValue(plan({ weeks: [{ startsAt: WEEK.startsAt, endsAt: WEEK.endsAt, scheduled: { id: 12, name: 'Eli Park' }, covers: [{ id: 5, technician: { id: 7 }, startsAt: at('2026-11-15', '09:00'), endsAt: at('2026-11-17', '17:00') }] }] }));
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ skipped: 'continuing', technicianId: 7 });
      expect(currentMock).toHaveBeenCalledWith(3, new Date(WEEK.startsAt.getTime() - 1));
      expect(botMock.sendToConversation).not.toHaveBeenCalled();
    });

    test('a failed look-back does not block the message', async () => {
      currentMock.mockRejectedValue(new Error('schedule read failed'));
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ sent: true, technicianId: 7 });
    });

    test('sends one message at the start, keyed on workspace + person + period start', async () => {
      const out = await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'));
      expect(out).toEqual({ sent: true, technicianId: 7 });
      expect(prismaMock.teamsDelivery.findFirst).toHaveBeenCalledWith({ where: { workspaceId: 3, technicianId: 7, eventKey: 'on_call_start', createdAt: { gte: WEEK.startsAt } }, select: { id: true } });
      expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'on_call_start', status: 'sent', reason: `oncall:3:7:${WEEK.startsAt.toISOString()}` }) });
      const card = botMock.cardActivity.mock.calls[0][0];
      expect(JSON.stringify(card)).toContain('Mon 16 Nov 5:00 PM PT to Mon 23 Nov 5:00 PM PT');
    });

    test('once per period: a second tick finds the row and sends nothing', async () => {
      prismaMock.teamsDelivery.findFirst.mockResolvedValue({ id: 901 });
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:20'))).toEqual({ skipped: 'already', technicianId: 7 });
      expect(botMock.sendToConversation).not.toHaveBeenCalled();
    });

    test('a failed read counts as "already" (never twice)', async () => {
      prismaMock.teamsDelivery.findFirst.mockRejectedValue(new Error('db down'));
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:20'))).toMatchObject({ skipped: 'already' });
    });

    test('comes through quiet hours and outside work hours', async () => {
      prismaMock.technicianNotificationPreference.findUnique.mockResolvedValue({ quietHoursEnabled: true, quietHoursStart: '17:00', quietHoursEnd: '08:00', workspaceId: 3 });
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ sent: true, technicianId: 7 });
    });

    test('the person\'s own Off is respected', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue({ events: { on_call_start: 'off' }, options: {} });
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ skipped: 'person_off', technicianId: 7 });
      expect(botMock.sendToConversation).not.toHaveBeenCalled();
    });

    test('workspace switch off, no rotation, or not the start: nothing', async () => {
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({}));
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ skipped: 'off' });
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ onCallNotice: true }));
      scheduleMock.mockResolvedValue({ configured: false, weeks: [] });
      expect(await extras.onCallNoticeFor(3, at('2026-11-16', '17:10'))).toEqual({ skipped: 'no_rotation' });
      scheduleMock.mockResolvedValue(plan());
      expect(await extras.onCallNoticeFor(3, at('2026-11-18', '17:10'))).toEqual({ skipped: 'not_starting' });
      expect(botMock.sendToConversation).not.toHaveBeenCalled();
    });

    test('runOnCallNotices only visits workspaces with the switch on', async () => {
      prismaMock.notificationWorkspaceSetting.findMany.mockResolvedValue([
        { workspaceId: 3, defaults: { extras: { onCallNotice: true } } },
        { workspaceId: 4, defaults: { extras: {} } },
      ]);
      const out = await extras.runOnCallNotices(at('2026-11-16', '17:10'));
      expect(out).toEqual([{ workspaceId: 3, sent: true, technicianId: 7 }]);
      expect(scheduleMock).toHaveBeenCalledTimes(1);
    });
  });
});

// ------------------------------------------------------------------ #4 surveys

describe('survey results', () => {
  const prefs = (events = {}, options = {}) => effectivePrefs(null, { events, options });

  test('scope: the handler with Mine or Everyone\'s; others only with Everyone\'s and only when privileged', () => {
    const people = [
      { technicianId: 7, prefs: prefs({ survey_result: 'teams' }), privileged: false },
      { technicianId: 12, prefs: prefs({ survey_result: 'digest' }, { surveyScope: 'all' }), privileged: true },
      { technicianId: 13, prefs: prefs({ survey_result: 'teams' }, { surveyScope: 'all' }), privileged: false },
      { technicianId: 14, prefs: prefs({ survey_result: 'teams' }, { surveyScope: 'mine' }), privileged: true },
      // QA 11-19 #1: the row is Teams by default now; Off is a choice.
      { technicianId: 15, prefs: prefs({ survey_result: 'off' }, { surveyScope: 'all' }), privileged: true },
    ];
    expect(surveyAudience({ people, assignedTechId: 7 })).toEqual([
      { technicianId: 7, why: 'mine', mode: 'teams' },
      { technicianId: 12, why: 'all', mode: 'digest' },
    ]);
    // Nobody assigned: only "everyone's".
    expect(surveyAudience({ people, assignedTechId: null }).map((a) => a.technicianId)).toEqual([12]);
  });

  test('the card: rating, comment (trimmed), ticket and handler; no totals', () => {
    const long = 'Fixed fast. '.repeat(60);
    const card = surveyResultCard({ ratingLabel: 'Great', score: 5, outOf: 5, comment: long, ref: 'TP-1201', subject: 'Badge reader at the front door', url: 'https://tp.example.com/tickets/1201', agentName: 'Dana Fox', requesterName: 'Priya Nair', source: 'ticketpulse' });
    const json = JSON.stringify(card);
    expect(json).toContain('Badge reader at the front door');
    expect(json).toContain('TP-1201 · 👤 Priya Nair');
    expect(json).toContain('⭐ Great · 5 of 5');
    expect(json).toContain('Dana Fox');
    expect(json).toContain('COMMENT');
    const comment = card.body.find((b) => b.style === 'emphasis').items[1].text;
    expect(comment.length).toBeLessThanOrEqual(404);
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open ticket', url: 'https://tp.example.com/tickets/1201' }]);
    expect(json).not.toMatch(/average|total|rank/i);
    expect(JSON.stringify(surveyResultCard({ ratingLabel: 'Happy', score: 3, outOf: 4, source: 'freshservice', ref: '#4501', subject: 'VPN' }))).toContain('FreshService satisfaction survey');
  });

  describe('dispatch', () => {
    const TICKET = { id: 1201, workspaceId: 3, subject: 'Badge reader at the front door', freshserviceTicketId: null, nativeNumber: 1201, origin: 'ticketpulse', assignedTechId: 7, requester: { name: 'Priya Nair' } };
    let spies = [];
    beforeEach(() => {
      prismaMock.ticket.findFirst.mockResolvedValue(TICKET);
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: true }));
      prismaMock.technician.findFirst.mockImplementation(async ({ where }) => ({ 7: DANA, 12: ELI }[where.id] || null));
      prismaMock.notificationPreference.findUnique.mockImplementation(async ({ where }) => (where.workspaceId_technicianId.technicianId === 7
        ? { events: { survey_result: 'teams', survey_response: 'off' }, options: { respectAway: false } } : null));
      prismaMock.notificationPreference.findMany.mockResolvedValue([
        { workspaceId: 3, technicianId: 7, events: { survey_result: 'teams', survey_response: 'off' }, options: { respectAway: false } },
        { workspaceId: 3, technicianId: 12, events: { survey_result: 'teams' }, options: { surveyScope: 'all' } },
      ]);
      spies = [
        jest.spyOn(svc, '_canSeeAllSurveys').mockImplementation(async (email) => email === ELI.email),
        jest.spyOn(svc, 'isRunning').mockReturnValue(true),
      ];
    });
    afterEach(() => spies.forEach((s) => s.mockRestore()));

    test('the handler and the admin who chose everyone\'s each get one card', async () => {
      const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, outOf: 5, ratingLabel: 'Great', comment: 'Quick fix', resultKey: '5:1' });
      expect(out).toMatchObject({ sent: 2, held: 0 });
      const to = botMock.sendToConversation.mock.calls.map((c) => c[0].conversationId);
      expect(to).toEqual([`conv-${DANA.email}`, `conv-${ELI.email}`]);
      expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'survey_result', status: 'sent', reason: 'survey:tp:1201:5:1', technicianId: 12 }) });
    });

    test('Eli loses the role: no more "everyone\'s" cards', async () => {
      svc._canSeeAllSurveys.mockResolvedValue(false);
      const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 2, resultKey: '2:1' });
      expect(out.sent).toBe(1);
      expect(botMock.sendToConversation.mock.calls[0][0].conversationId).toBe(`conv-${DANA.email}`);
    });

    test('QA 11-19 #1: a handler with the old row on gets this card (it is the only one now)', async () => {
      prismaMock.notificationPreference.findUnique.mockResolvedValue({ events: { survey_result: 'teams', survey_response: 'teams' }, options: { respectAway: false } });
      const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 4, resultKey: '4:1' });
      expect(out.skipped).toEqual([]);
      expect(out.sent).toBe(2);
    });

    test('FreshService CSAT: found by the ticket\'s FS id, once per response, only recent', async () => {
      prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, origin: 'freshservice', freshserviceTicketId: BigInt(244501), nativeNumber: null });
      const now = new Date('2026-11-17T20:00:00Z');
      const fresh = await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, outOf: 4, ratingLabel: 'Happy', submittedAt: new Date('2026-11-17T18:00:00Z'), resultKey: '777', now });
      expect(fresh.sent).toBe(2);
      expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ freshserviceTicketId: BigInt(244501) });
      prismaMock.teamsDelivery.findFirst.mockResolvedValue({ id: 1 });
      const again = await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, resultKey: '777', submittedAt: new Date('2026-11-17T18:00:00Z'), now });
      expect(again.sent).toBe(0);
      expect(again.skipped.map((s) => s.why)).toEqual(['already', 'already']);
      const old = await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3, submittedAt: new Date('2026-11-01T18:00:00Z'), now });
      expect(old.off).toBe('old');
    });

    test('a CSAT seen by a script (the app is not running) is not announced', async () => {
      svc.isRunning.mockReturnValue(false);
      expect((await extras._notifySurveyResult({ freshserviceTicketId: 244501, source: 'freshservice', score: 3 })).off).toBe('not_in_app');
    });

    test('Digest holds it; the workspace switch off sends no "everyone\'s"; Teams off sends nothing', async () => {
      prismaMock.notificationPreference.findMany.mockResolvedValue([{ workspaceId: 3, technicianId: 12, events: { survey_result: 'digest' }, options: { surveyScope: 'all' } }]);
      prismaMock.ticket.findFirst.mockResolvedValue({ ...TICKET, assignedTechId: null });
      const out = await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, resultKey: '5:2' });
      expect(out).toMatchObject({ sent: 0, held: 1 });
      expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'digest', eventKey: 'survey_result', technicianId: 12 }) });
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue(wsRow({ surveyResults: false }));
      expect(await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5, resultKey: '5:3' })).toEqual({ sent: 0, held: 0, skipped: [] });
      prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ ...wsRow({ surveyResults: true }), teamsEnabled: false });
      expect((await extras._notifySurveyResult({ ticketId: 1201, source: 'ticketpulse', score: 5 })).off).toBe('off');
    });
  });
});

// ------------------------------------------------------------------ the digest card

describe('digest card: the "since" variant reuses digestCard', () => {
  test('banner, summary line, and "more" counted against what is new', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ref: `TP-${i}`, subject: `Ticket ${i}`, url: 'https://x/t', priority: 2, dueLabel: '' }));
    const card = digestCard({ name: 'Dana Fox', counts: { open: 40, overdue: 1, dueToday: 2 }, rows, queueUrl: 'https://x/q', held: [], since: { label: 'Since your 9:00 AM PT digest', summary: '12 tickets assigned to you', total: 12 } });
    const json = JSON.stringify(card);
    expect(json).toContain('"text":"Since your 9:00 AM PT digest  ↗"');
    expect(json).toContain('**Since your 9:00 AM PT digest:** 12 tickets assigned to you');
    expect(json).toContain('ASSIGNED TO YOU SINCE THEN');
    expect(json).toContain('and 2 more');
    expect(json).not.toContain('and 30 more');
  });
});
