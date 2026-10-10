import { jest } from '@jest/globals';

/**
 * Urgent response settings (plans/URGENT_RESPONSE_PLAN.md): defaults without a
 * row, never created on read, validated saves with one audit row per changed
 * field in the same transaction, people checked against the workspace, the
 * baseline cleared when a save brings tickets into scope, and the old weekly
 * rotation offered as a suggestion only.
 */
const prismaMock = {
  urgentResponseSettings: { findUnique: jest.fn(), upsert: jest.fn((args) => ({ op: 'upsert', args })) },
  urgentResponseSettingsChange: { createMany: jest.fn((args) => ({ op: 'createMany', args })), findMany: jest.fn() },
  urgentEscalationPolicy: { findUnique: jest.fn() },
  technician: { findMany: jest.fn(), findFirst: jest.fn() },
  workspace: { findUnique: jest.fn() },
  $transaction: jest.fn(async (ops) => ops),
};
const teamsMock = { workspaceSettings: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/teamsNotificationService.js', () => ({ default: teamsMock }));

const { default: settings } = await import('../src/services/urgentResponse/settingsService.js');
const { DEFAULT_SETTINGS, onCallWeek } = await import('../src/services/urgentResponse/rules.js');

const ACTOR = { email: 'vhaeri@example.com', name: 'Vahid Haeri' };
const ROW = {
  workspaceId: 1, mode: 'observe', assignEnabled: true, assignPriorities: [4, 3], assignGraceMinutes: 30, raiseEnabled: true, raisePriorities: [4],
  raiseManualAction: 'notify', clockEnabled: true, clockPriorities: [4], clockNotifyMinutes: 15, clockMoveMinutes: 30, notifyAudience: 'on_shift',
  notifyTechnicianIds: [], notifyChannels: ['teams', 'email'], nobodyMode: 'hold', nobodyContactTechnicianId: null, coordinatorTechnicianId: null, maxMoves: 2,
  onCallOrder: [], onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: null,
  baselinedAt: new Date('2026-10-09T00:00:00Z'), updatedBy: 'someone@example.com', createdAt: new Date('2026-10-08T00:00:00Z'), updatedAt: new Date('2026-10-09T00:00:00Z'),
};
const upsertData = () => prismaMock.urgentResponseSettings.upsert.mock.calls[0][0];
const auditRows = () => prismaMock.urgentResponseSettingsChange.createMany.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW });
  prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue(null);
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
  prismaMock.technician.findMany.mockImplementation(async ({ where }) => (where.id?.in || []).filter((id) => id < 100).map((id) => ({ id })));
  prismaMock.urgentResponseSettingsChange.findMany.mockResolvedValue([]);
});

describe('getSettings / getMode', () => {
  test('no row: the defaults with mode off, and nothing is written', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue(null);
    const s = await settings.getSettings(2);
    expect(s).toMatchObject({ ...DEFAULT_SETTINGS, workspaceId: 2, persisted: false, onCallOrderSuggested: false, baselinedAt: null, updatedBy: null, updatedAt: null });
    expect(prismaMock.urgentResponseSettings.upsert).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(await settings.getMode(2)).toBe('off');
  });

  test('a stored row comes back as camelCase JSON with the bookkeeping fields', async () => {
    const s = await settings.getSettings(1);
    expect(s).toMatchObject({ mode: 'observe', persisted: true, updatedBy: 'someone@example.com', baselinedAt: ROW.baselinedAt, onCallOrder: [], onCallAnchorDate: null });
    expect(await settings.getMode(1)).toBe('observe');
  });

  test('a missing table degrades to the defaults instead of throwing', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockRejectedValue(new Error('relation "urgent_response_settings" does not exist'));
    await expect(settings.getSettings(1)).resolves.toMatchObject({ mode: 'off', persisted: false });
    await expect(settings.getMode(1)).resolves.toBe('off');
    prismaMock.urgentResponseSettingsChange.findMany.mockRejectedValue(new Error('missing'));
    await expect(settings.listChanges(1)).resolves.toEqual([]);
  });

  test('an unknown mode in the row reads as off', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ mode: 'loud' });
    expect(await settings.getMode(1)).toBe('off');
  });

  test('the old weekly rotation is offered as a suggestion while no order is saved', async () => {
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ afterHoursRotationOrder: [5, 300, 7, 5], afterHoursRotationAnchorDate: new Date('2026-10-05T07:00:00Z') });
    const s = await settings.getSettings(1);
    // 300 is not an active technician here any more.
    expect(s).toMatchObject({ onCallOrder: [5, 7], onCallOrderSuggested: true, onCallAnchorDate: '2026-10-05' });
    // The callers that act on the order never see the suggestion.
    const raw = await settings.getSettings(1, { suggest: false });
    expect(raw).toMatchObject({ onCallOrder: [], onCallOrderSuggested: false, onCallAnchorDate: null });
    expect(prismaMock.technician.findMany.mock.calls[0][0].select).toEqual({ id: true });
  });

  test('a saved order is never replaced by the suggestion', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, onCallOrder: [9], onCallAnchorDate: new Date('2026-10-12T00:00:00Z') });
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ afterHoursRotationOrder: [5, 7], afterHoursRotationAnchorDate: null });
    const s = await settings.getSettings(1);
    expect(s).toMatchObject({ onCallOrder: [9], onCallOrderSuggested: false, onCallAnchorDate: '2026-10-12' });
    expect(prismaMock.urgentEscalationPolicy.findUnique).not.toHaveBeenCalled();
  });
});

describe('updateSettings', () => {
  test('a partial save writes the row and one audit row per changed field, in one transaction', async () => {
    const result = await settings.updateSettings(1, { clockNotifyMinutes: 10, clockMoveMinutes: 20, junk: true }, ACTOR);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.$transaction.mock.calls[0][0].map((op) => op.op)).toEqual(['upsert', 'createMany']);
    const { where, create, update } = upsertData();
    expect(where).toEqual({ workspaceId: 1 });
    expect(update).toMatchObject({ mode: 'observe', clockNotifyMinutes: 10, clockMoveMinutes: 20, updatedBy: 'vhaeri@example.com' });
    expect(create).toMatchObject({ workspaceId: 1, clockNotifyMinutes: 10 });
    expect(update.junk).toBeUndefined();
    // Nothing new came into scope: the baseline stays.
    expect('baselinedAt' in update).toBe(false);
    expect(auditRows()).toEqual([
      { workspaceId: 1, changedBy: 'vhaeri@example.com', changedByName: 'Vahid Haeri', field: 'clockNotifyMinutes', before: 15, after: 10 },
      { workspaceId: 1, changedBy: 'vhaeri@example.com', changedByName: 'Vahid Haeri', field: 'clockMoveMinutes', before: 30, after: 20 },
    ]);
    expect(result.changes.map((c) => c.field)).toEqual(['clockNotifyMinutes', 'clockMoveMinutes']);
    expect(result.settings).toMatchObject({ workspaceId: 1 });
  });

  test('nothing changed: nothing is written', async () => {
    const result = await settings.updateSettings(1, { clockNotifyMinutes: 15, assignPriorities: [3, 4] }, ACTOR);
    expect(result.changes).toEqual([]);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('the first save creates the row even with nothing changed, and asks for a baseline', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue(null);
    await settings.updateSettings(3, {}, ACTOR);
    expect(prismaMock.$transaction.mock.calls[0][0].map((op) => op.op)).toEqual(['upsert']);
    expect(upsertData().create).toMatchObject({ workspaceId: 3, mode: 'off', baselinedAt: null });
  });

  test.each([
    ['Shadow to Live', { mode: 'live' }],
    ['High joins the clock', { clockPriorities: [4, 3] }],
    ['High joins the raise layer', { raisePriorities: [3, 4] }],
  ])('%s clears the baseline', async (_label, patch) => {
    await settings.updateSettings(1, patch, ACTOR);
    expect(upsertData().update.baselinedAt).toBeNull();
  });

  test('leaving off clears the baseline; going off, or narrowing, does not', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, mode: 'off' });
    await settings.updateSettings(1, { mode: 'observe' }, ACTOR);
    expect(upsertData().update.baselinedAt).toBeNull();

    jest.clearAllMocks();
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, clockPriorities: [4, 3] });
    await settings.updateSettings(1, { mode: 'off', clockPriorities: [4] }, ACTOR);
    expect('baselinedAt' in upsertData().update).toBe(false);
  });

  test('an invalid save is refused before anything is read or written about people', async () => {
    await expect(settings.updateSettings(1, { clockNotifyMinutes: 40 }, ACTOR)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('cannot be shorter') });
    await expect(settings.updateSettings(1, { mode: 'loud' }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    await expect(settings.updateSettings(1, { nobodyMode: 'on_call' }, ACTOR)).rejects.toMatchObject({ message: expect.stringContaining('on-call order') });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
  });

  test('people must be active technicians of this workspace', async () => {
    await expect(settings.updateSettings(1, { coordinatorTechnicianId: 500 }, ACTOR)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('Coordinator') });
    await expect(settings.updateSettings(1, { onCallOrder: [5, 500] }, ACTOR)).rejects.toMatchObject({ message: expect.stringContaining('On-call order') });
    await expect(settings.updateSettings(1, { notifyAudience: 'named', notifyTechnicianIds: [500] }, ACTOR)).rejects.toMatchObject({ message: expect.stringContaining('Who is told') });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    const { where, select } = prismaMock.technician.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ workspaceId: 1, isActive: true });
    expect(select).toEqual({ id: true });

    await settings.updateSettings(1, { coordinatorTechnicianId: 5, nobodyContactTechnicianId: 6 }, ACTOR);
    expect(upsertData().update).toMatchObject({ coordinatorTechnicianId: 5, nobodyContactTechnicianId: 6 });
  });

  test('a person already saved is not re-checked by a save that does not touch them', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, coordinatorTechnicianId: 500 });
    await settings.updateSettings(1, { maxMoves: 3 }, ACTOR);
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
    expect(upsertData().update).toMatchObject({ coordinatorTechnicianId: 500, maxMoves: 3 });
  });

  test('the first on-call order gets its first handover date: the handover on or before now, in the workspace zone', async () => {
    // Wednesday 14 Oct 2026, 09:00 in Vancouver → the Monday 12 Oct handover.
    await settings.updateSettings(1, { onCallOrder: [5, 7] }, ACTOR, { now: new Date('2026-10-14T16:00:00Z') });
    expect(upsertData().update.onCallOrder).toEqual([5, 7]);
    expect(upsertData().update.onCallAnchorDate).toEqual(new Date('2026-10-12T00:00:00.000Z'));
    expect(auditRows().map((r) => r.field)).toEqual(['onCallOrder', 'onCallAnchorDate']);
    // A null "before" is left out of the audit row (SQL NULL), never passed as a bare null.
    expect(auditRows()[1]).toEqual({ workspaceId: 1, changedBy: ACTOR.email, changedByName: ACTOR.name, field: 'onCallAnchorDate', after: '2026-10-12' });
  });

  test('a suggested order is not saved by an unrelated save', async () => {
    prismaMock.urgentEscalationPolicy.findUnique.mockResolvedValue({ afterHoursRotationOrder: [5, 7], afterHoursRotationAnchorDate: null });
    await settings.updateSettings(1, { maxMoves: 1 }, ACTOR);
    expect(upsertData().update.onCallOrder).toEqual([]);
    expect(auditRows().map((r) => r.field)).toEqual(['maxMoves']);
  });

  test('an anchor the admin gives is kept', async () => {
    await settings.updateSettings(1, { onCallOrder: [5], onCallAnchorDate: '2026-11-02' }, ACTOR);
    expect(upsertData().update.onCallAnchorDate).toEqual(new Date('2026-11-02T00:00:00.000Z'));
  });
});

describe('updateSettings: "this person is on call this week" (onCallCurrentTechnicianId)', () => {
  const TZ = 'America/Vancouver';
  const MIDWEEK = new Date('2026-10-14T16:00:00Z'); // Wednesday 14 Oct, 09:00 in Vancouver
  const BEFORE_HANDOVER = new Date('2026-10-12T23:59:00Z'); // Monday 12 Oct, 16:59 in Vancouver
  const AFTER_HANDOVER = new Date('2026-10-13T00:01:00Z'); // Monday 12 Oct, 17:01 in Vancouver
  const savedAnchor = () => upsertData().update.onCallAnchorDate.toISOString().slice(0, 10);
  const onCallAt = (order, anchor, at) => onCallWeek({ onCallOrder: order, onCallHandoverDay: 1, onCallHandoverTime: '17:00', onCallAnchorDate: anchor }, TZ, at).technicianId;

  test('the first person in the order: the anchor is the handover date of this week', async () => {
    await settings.updateSettings(1, { onCallOrder: [5, 7, 9], onCallCurrentTechnicianId: 5 }, ACTOR, { now: MIDWEEK });
    expect(savedAnchor()).toBe('2026-10-12');
    expect(onCallAt([5, 7, 9], savedAnchor(), MIDWEEK)).toBe(5);
  });

  test('a person further down the order: one week earlier per place, and the rotation says so', async () => {
    await settings.updateSettings(1, { onCallOrder: [5, 7, 9], onCallCurrentTechnicianId: 9 }, ACTOR, { now: MIDWEEK });
    expect(savedAnchor()).toBe('2026-09-28');
    expect(onCallAt([5, 7, 9], savedAnchor(), MIDWEEK)).toBe(9);
    // Next week it is the first person's turn again.
    expect(onCallAt([5, 7, 9], savedAnchor(), new Date('2026-10-21T16:00:00Z'))).toBe(5);
    // Audited as the anchor it implies; the person is not a stored field.
    expect(auditRows().map((r) => r.field)).toEqual(['onCallOrder', 'onCallAnchorDate']);
    expect(auditRows()[1]).toMatchObject({ field: 'onCallAnchorDate', after: '2026-09-28' });
    expect(upsertData().update.onCallCurrentTechnicianId).toBeUndefined();
  });

  test('the handover minute: before 17:00 on the handover day it is still last week', async () => {
    await settings.updateSettings(1, { onCallOrder: [5, 7, 9], onCallCurrentTechnicianId: 7 }, ACTOR, { now: BEFORE_HANDOVER });
    // The week in force started Monday 5 Oct; the second person → one week earlier.
    expect(savedAnchor()).toBe('2026-09-28');
    expect(onCallAt([5, 7, 9], savedAnchor(), BEFORE_HANDOVER)).toBe(7);
    // Two minutes later the phone has moved on to the next person.
    expect(onCallAt([5, 7, 9], savedAnchor(), AFTER_HANDOVER)).toBe(9);

    jest.clearAllMocks();
    await settings.updateSettings(1, { onCallOrder: [5, 7, 9], onCallCurrentTechnicianId: 7 }, ACTOR, { now: AFTER_HANDOVER });
    // The week in force started Monday 12 Oct.
    expect(savedAnchor()).toBe('2026-10-05');
    expect(onCallAt([5, 7, 9], savedAnchor(), AFTER_HANDOVER)).toBe(7);
  });

  test('it replaces a saved anchor, wins over one sent in the same save, and is logged as onCallAnchorDate', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, onCallOrder: [5, 7], onCallAnchorDate: new Date('2026-10-12T00:00:00Z') });
    await settings.updateSettings(1, { onCallCurrentTechnicianId: '7', onCallAnchorDate: '2026-01-05' }, ACTOR, { now: MIDWEEK });
    expect(savedAnchor()).toBe('2026-10-05');
    expect(auditRows()).toEqual([{ workspaceId: 1, changedBy: ACTOR.email, changedByName: ACTOR.name, field: 'onCallAnchorDate', before: '2026-10-12', after: '2026-10-05' }]);
    // The order was not sent, so nobody is re-checked.
    expect(prismaMock.technician.findMany).not.toHaveBeenCalled();
  });

  test('the person who is already on call: nothing changes, nothing is written', async () => {
    // An old anchor, several rotations ago, that still lands on 7 this week.
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, onCallOrder: [5, 7], onCallAnchorDate: new Date('2026-09-07T00:00:00Z') });
    expect(onCallAt([5, 7], '2026-09-07', MIDWEEK)).toBe(7);
    const result = await settings.updateSettings(1, { onCallCurrentTechnicianId: 7 }, ACTOR, { now: MIDWEEK });
    expect(result.changes).toEqual([]);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  test('someone who is not in the order is refused in plain words; an empty value is ignored', async () => {
    prismaMock.urgentResponseSettings.findUnique.mockResolvedValue({ ...ROW, onCallOrder: [5, 7], onCallAnchorDate: new Date('2026-10-12T00:00:00Z') });
    for (const bad of [9, 'abc', 0]) {
      await expect(settings.updateSettings(1, { onCallCurrentTechnicianId: bad }, ACTOR)).rejects.toMatchObject({
        statusCode: 400, message: 'On call this week: pick someone who is in the on-call order',
      });
    }
    // Removed from the order in the same save.
    await expect(settings.updateSettings(1, { onCallOrder: [5], onCallCurrentTechnicianId: 7 }, ACTOR)).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    for (const empty of [null, '']) {
      await settings.updateSettings(1, { onCallCurrentTechnicianId: empty, maxMoves: 3 }, ACTOR);
      expect(auditRows().map((r) => r.field)).toEqual(['maxMoves']);
      jest.clearAllMocks();
    }
  });
});

describe('the small reads', () => {
  test('listChanges is newest first and capped', async () => {
    await settings.listChanges(1, { limit: '9999' });
    expect(prismaMock.urgentResponseSettingsChange.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 1 }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 500,
    });
    await settings.listChanges(1);
    expect(prismaMock.urgentResponseSettingsChange.findMany.mock.calls[1][0].take).toBe(50);
  });

  test('listChanges rows: who, when, the camelCase field, before and after (null when there was none)', async () => {
    const at = new Date('2026-10-10T18:00:00Z');
    prismaMock.urgentResponseSettingsChange.findMany.mockResolvedValue([
      { id: 9, workspaceId: 1, changedBy: 'vhaeri@example.com', changedByName: 'Vahid Haeri', field: 'clockNotifyMinutes', before: 15, after: 10, createdAt: at },
      { id: 8, workspaceId: 1, changedBy: null, changedByName: null, field: 'onCallAnchorDate', before: null, after: '2026-10-12', createdAt: at },
    ]);
    expect(await settings.listChanges(1)).toEqual([
      { id: 9, changedBy: 'vhaeri@example.com', changedByName: 'Vahid Haeri', field: 'clockNotifyMinutes', before: 15, after: 10, createdAt: at },
      { id: 8, changedBy: null, changedByName: null, field: 'onCallAnchorDate', before: null, after: '2026-10-12', createdAt: at },
    ]);
  });

  test('listTechnicians never selects the photo and is capped', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 5, name: 'Andrew Fong' }]);
    expect(await settings.listTechnicians(1)).toEqual([{ id: 5, name: 'Andrew Fong' }]);
    const { where, select, take } = prismaMock.technician.findMany.mock.calls[0][0];
    expect(where).toEqual({ workspaceId: 1 });
    expect(select).toEqual({ id: true, name: true, email: true, isActive: true, timezone: true, workStartTime: true, workEndTime: true });
    expect(select.photoUrl).toBeUndefined();
    expect(take).toBe(500);
  });

  test('technicianForEmail: the active technician with that e-mail in this workspace', async () => {
    prismaMock.technician.findFirst.mockResolvedValue({ id: 5, name: 'Andrew Fong', email: 'afong@example.com' });
    expect(await settings.technicianForEmail(1, ' AFong@Example.com ')).toMatchObject({ id: 5 });
    expect(prismaMock.technician.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 1, isActive: true, email: { equals: 'afong@example.com', mode: 'insensitive' } },
      select: { id: true, name: true, email: true },
    });
    expect(await settings.technicianForEmail(1, '')).toBeNull();
  });

  test('teamsEnabled reads the workspace switch and never throws', async () => {
    teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: true });
    expect(await settings.teamsEnabled(1)).toBe(true);
    teamsMock.workspaceSettings.mockResolvedValue({ teamsEnabled: false });
    expect(await settings.teamsEnabled(1)).toBe(false);
    teamsMock.workspaceSettings.mockRejectedValue(new Error('down'));
    expect(await settings.teamsEnabled(1)).toBe(false);
  });

  test('timezone falls back when the workspace has none', async () => {
    expect(await settings.timezone(1)).toBe('America/Vancouver');
    prismaMock.workspace.findUnique.mockResolvedValue(null);
    expect(await settings.timezone(1)).toBe('America/Los_Angeles');
  });
});
