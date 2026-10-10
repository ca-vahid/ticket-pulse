import { jest } from '@jest/globals';

/**
 * Urgent response — the engine (plans/URGENT_RESPONSE_PLAN.md): the baseline,
 * the three layers live and in Shadow, touch detection, the chain and the
 * coordinator, nobody at work (hold and on-call), move failures, undo, the
 * assignment guard, the reads, and the sweep's guards.
 *
 * A small in-memory Prisma stands in for the database, so the clock rows the
 * engine writes are the ones it reads back on the next sweep.
 *
 * Wednesday 14 Oct 2026 in Vancouver. Andrew (11), Maria (22) and Susan (44)
 * work 09:00–17:00; David (33) works 13:00–21:00.
 */
const TZ = 'America/Vancouver';
const cmp = (v) => (v instanceof Date ? v.getTime() : v);
function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'NOT') return !matches(row, cond);
    if (key === 'OR') return cond.some((c) => matches(row, c));
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return cmp(v) === cmp(cond);
    if (typeof cond !== 'object') return v === cond;
    return Object.entries(cond).every(([op, x]) => {
      if (op === 'in') return x.includes(v);
      if (op === 'notIn') return !x.includes(v);
      if (op === 'not') return x === null ? (v !== null && v !== undefined) : v !== x;
      if (op === 'gt') return v !== null && v !== undefined && cmp(v) > cmp(x);
      if (op === 'gte') return v !== null && v !== undefined && cmp(v) >= cmp(x);
      if (op === 'lt') return v !== null && v !== undefined && cmp(v) < cmp(x);
      if (op === 'lte') return v !== null && v !== undefined && cmp(v) <= cmp(x);
      return true;
    });
  });
}
const sorted = (rows, orderBy) => {
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean).flatMap((o) => Object.entries(o));
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      if (cmp(a[k]) === cmp(b[k])) continue;
      return (cmp(a[k]) < cmp(b[k]) ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
};
const table = (rows) => ({
  findMany: jest.fn(async ({ where = {}, orderBy = null, take = 1e9 } = {}) => sorted(rows().filter((r) => matches(r, where)), orderBy).slice(0, take).map((r) => ({ ...r }))),
  findFirst: jest.fn(async ({ where = {}, orderBy = null } = {}) => {
    const hit = sorted(rows().filter((r) => matches(r, where)), orderBy)[0];
    return hit ? { ...hit } : null;
  }),
});

const db = {
  settingsRows: [], tickets: [], clocks: [], actions: [], technicians: [], leaves: [], competencies: [], categories: [],
  activities: [], entries: [], runs: [], episodes: [], groups: [], members: [], prefs: [], events: [],
};
let nextActionId = 1;
const prismaMock = {
  urgentResponseSettings: {
    ...table(() => db.settingsRows),
    updateMany: jest.fn(async ({ where, data }) => {
      const hits = db.settingsRows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
  },
  urgentResponseClock: {
    ...table(() => db.clocks),
    findUnique: jest.fn(async ({ where }) => {
      const hit = db.clocks.find((c) => c.ticketId === where.ticketId);
      return hit ? { ...hit } : null;
    }),
    upsert: jest.fn(async ({ where, create, update }) => {
      const hit = db.clocks.find((c) => c.ticketId === where.ticketId);
      if (hit) return Object.assign(hit, update);
      db.clocks.push({ notifiedAt: null, moveCount: 0, chainTechnicianIds: [], ...create });
      return create;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const hits = db.clocks.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
    deleteMany: jest.fn(async ({ where }) => {
      const before = db.clocks.length;
      db.clocks = db.clocks.filter((r) => !matches(r, where));
      return { count: before - db.clocks.length };
    }),
    createMany: jest.fn(async ({ data }) => {
      const fresh = data.filter((d) => !db.clocks.some((c) => c.ticketId === d.ticketId));
      db.clocks.push(...fresh.map((d) => ({ notifyAt: null, moveAt: null, notifiedAt: null, moveCount: 0, chainTechnicianIds: [], ...d })));
      return { count: fresh.length };
    }),
  },
  urgentResponseAction: {
    ...table(() => db.actions),
    findUnique: jest.fn(async ({ where }) => {
      const hit = db.actions.find((a) => a.id === where.id);
      return hit ? { ...hit } : null;
    }),
    create: jest.fn(async ({ data }) => {
      if (data.dedupeKey && db.actions.some((a) => a.dedupeKey === data.dedupeKey)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      const row = { id: nextActionId++, createdAt: new Date('2026-10-14T17:00:00Z'), undoneAt: null, undoneBy: null, undoOfId: null, details: null, ...data };
      db.actions.push(row);
      return { ...row };
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const hits = db.actions.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }),
    groupBy: jest.fn(async ({ where }) => {
      const groups = new Map();
      for (const a of db.actions.filter((r) => matches(r, where))) {
        const key = `${a.action}|${a.shadow}|${a.layer}`;
        if (!groups.has(key)) groups.set(key, { action: a.action, shadow: a.shadow, layer: a.layer, _count: { _all: 0 } });
        groups.get(key)._count._all += 1;
      }
      return [...groups.values()];
    }),
  },
  ticket: {
    ...table(() => db.tickets),
    findUnique: jest.fn(async ({ where }) => {
      const hit = db.tickets.find((t) => t.id === where.id);
      return hit ? { ...hit } : null;
    }),
    count: jest.fn(async ({ where }) => db.tickets.filter((r) => matches(r, where)).length),
    groupBy: jest.fn(async ({ where, _max }) => {
      const groups = new Map();
      for (const t of db.tickets.filter((r) => matches(r, where))) {
        const g = groups.get(t.assignedTechId) || { assignedTechId: t.assignedTechId, _count: { _all: 0 }, _max: { assignedAt: null } };
        g._count._all += 1;
        if (_max && t.assignedAt && (!g._max.assignedAt || t.assignedAt > g._max.assignedAt)) g._max.assignedAt = t.assignedAt;
        groups.set(t.assignedTechId, g);
      }
      return [...groups.values()];
    }),
  },
  technician: table(() => db.technicians),
  technicianLeave: table(() => db.leaves),
  technicianCompetency: table(() => db.competencies),
  competencyCategory: table(() => db.categories),
  ticketActivity: table(() => db.activities),
  ticketThreadEntry: table(() => db.entries),
  assignmentPipelineRun: table(() => db.runs),
  ticketAssignmentEpisode: table(() => db.episodes),
  group: table(() => db.groups),
  groupMember: table(() => db.members),
  ticketPriorityEvent: table(() => db.events),
};

const settingsMock = { getSettings: jest.fn(), getMode: jest.fn(), timezone: jest.fn() };
const onCallMock = { current: jest.fn(), dailyCoverCheck: jest.fn() };
const calendarMock = { loadCalendar: jest.fn(), addBusinessMinutes: jest.fn() };
const activityCreate = jest.fn();
const assignTicket = jest.fn();
const updateFsTicket = jest.fn();
const tellPeople = jest.fn();
const textOnCall = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/urgentResponse/settingsService.js', () => ({
  default: settingsMock,
  soft: (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback),
}));
jest.unstable_mockModule('../src/services/urgentResponse/onCallService.js', () => ({ default: onCallMock }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: calendarMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: activityCreate } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { assignTicket, updateFsTicket } }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({ openWorkloadStatuses: jest.fn(async () => ['Open', 'Pending']) }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { getServiceAccountNames: jest.fn(async () => ['Service Account']) } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({
  countsAsRealActivity: (entry) => !['ticket workflow', 'supervisor', 'system'].includes(String(entry.actorName || '').toLowerCase()),
}));

const { default: engine, threadEntryIsTouch } = await import('../src/services/urgentResponse/urgentResponseService.js');
const { handoverInstant, normalizeSettings } = await import('../src/services/urgentResponse/rules.js');

const at = (dateStr, time) => handoverInstant(dateStr, time, TZ);
const WED_10 = at('2026-10-14', '10:00');
const WED_NIGHT = at('2026-10-14', '23:00');
const THU_0905 = at('2026-10-15', '09:05');
const minutes = (d, n) => new Date(d.getTime() + n * 60000);

const tech = (id, name, extra = {}) => ({
  id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, isActive: true, assignableOnly: false, origin: 'freshservice', freshserviceId: BigInt(9000 + id),
  timezone: TZ, workStartTime: '09:00', workEndTime: '17:00', workspaceId: 1, ...extra,
});
const ticketRow = (id, extra = {}) => ({
  id, workspaceId: 1, origin: 'ticketpulse', nativeNumber: id, freshserviceTicketId: null, subject: `Ticket ${id}`, status: 'Open', priority: 4, assessedPriorityId: null,
  assignedTechId: 33, assignedAt: new Date('2026-10-14T15:00:00Z'), assignedBy: 'Ticket Pulse', isSelfPicked: false, parkedUntil: null, groupId: null, internalGroupId: null,
  internalCategoryId: null, internalSubcategoryId: null, createdAt: new Date('2026-10-14T15:00:00Z'), requester: { name: 'Rita Requester', email: 'rita@example.com' }, ...extra,
});
const clockOf = (ticketId) => db.clocks.find((c) => c.ticketId === ticketId) || null;
const actionsOf = (action) => db.actions.filter((a) => a.action === action);
const ticketOf = (id) => db.tickets.find((t) => t.id === id);

let settings;
function use(overrides = {}, { baselined = true } = {}) {
  settings = normalizeSettings({ mode: 'live', coordinatorTechnicianId: 44, ...overrides });
  db.settingsRows = settings.mode === 'off' ? [] : [{ workspaceId: 1, mode: settings.mode, baselinedAt: baselined ? new Date('2026-10-01T00:00:00Z') : null }];
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(db).forEach((k) => { db[k] = []; });
  nextActionId = 1;
  engine._running = false;
  engine._coverCheckedAt.clear();
  engine._notifier = async () => ({ tellPeople, textOnCall });
  db.technicians = [tech(11, 'Andrew Fong'), tech(22, 'Maria Lee'), tech(33, 'David Zapata', { workStartTime: '13:00', workEndTime: '21:00' }), tech(44, 'Susan Xu')];
  use();
  settingsMock.getSettings.mockImplementation(async () => ({ workspaceId: 1, ...settings }));
  settingsMock.getMode.mockImplementation(async () => settings.mode);
  settingsMock.timezone.mockResolvedValue(TZ);
  onCallMock.current.mockResolvedValue({ configured: false, technician: null, onLeaveNoCover: false });
  onCallMock.dailyCoverCheck.mockResolvedValue({ checked: 0 });
  // No business-hours rows: Mon–Fri by default, and the deadlines are wall-clock minutes.
  calendarMock.loadCalendar.mockResolvedValue(null);
  calendarMock.addBusinessMinutes.mockImplementation(async (from, n) => minutes(new Date(from), n));
  activityCreate.mockResolvedValue({});
  const reassign = async (ticketId, _ws, target) => {
    const techId = typeof target === 'object' ? target.assignedTechId : target;
    Object.assign(ticketOf(ticketId), { assignedTechId: techId });
    return {};
  };
  assignTicket.mockImplementation(reassign);
  updateFsTicket.mockImplementation(reassign);
  tellPeople.mockResolvedValue({ people: 1, teams: { sent: 1 }, email: { sent: 1 } });
  textOnCall.mockResolvedValue({ sent: true });
});

describe('baseline', () => {
  test('tickets already in scope get a stopped clock and nothing else happens', async () => {
    use({}, { baselined: false });
    db.tickets = [ticketRow(1), ticketRow(2, { assignedTechId: 11 }), ticketRow(3, { priority: 2 }), ticketRow(4, { assignedTechId: null })];
    const out = await engine.sweep({ now: WED_10 });
    expect(out.baselined).toBe(2);
    expect(db.clocks.map((c) => [c.ticketId, c.state, c.stopReason, c.ownerTechnicianId])).toEqual([[1, 'stopped', 'baseline', 33], [2, 'stopped', 'baseline', 11]]);
    expect(db.settingsRows[0].baselinedAt).toEqual(WED_10);
    expect(db.actions).toHaveLength(0);
    expect(assignTicket).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();

    // The next sweep sees the same tickets and still leaves them alone.
    await engine.sweep({ now: minutes(WED_10, 1) });
    expect(db.actions).toHaveLength(0);
    expect(clockOf(1).state).toBe('stopped');
  });

  test('a clock already running in this mode survives a new baseline', async () => {
    use({}, { baselined: false });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    db.clocks = [{ ticketId: 1, workspaceId: 1, ownerTechnicianId: 11, state: 'running', startedAt: minutes(WED_10, -5), notifyAt: minutes(WED_10, 10), moveAt: minutes(WED_10, 25), notifiedAt: null, moveCount: 0, chainTechnicianIds: [], shadow: false }];
    await engine.sweep({ now: WED_10 });
    expect(clockOf(1).state).toBe('running');
  });
});

describe('layer 2: a ticket enters scope', () => {
  test('owner at work: a running clock with the deadlines in business minutes', async () => {
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    const out = await engine.sweep({ now: WED_10 });
    expect(out.started).toBe(1);
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 11, startedAt: WED_10, notifyAt: minutes(WED_10, 15), moveAt: minutes(WED_10, 30), moveCount: 0, shadow: false });
    expect(calendarMock.addBusinessMinutes).toHaveBeenCalledWith(WED_10, 15, { workspaceId: 1, calendar: null });
    expect(calendarMock.addBusinessMinutes).toHaveBeenCalledWith(WED_10, 30, { workspaceId: 1, calendar: null });
    expect(db.actions).toHaveLength(0);
  });

  test('owner away and auto-assigned: moved to the best person at work, both are told, a new clock for the new owner', async () => {
    db.tickets = [ticketRow(1), ticketRow(50, { assignedTechId: 11, priority: 2 })]; // Andrew has one open ticket, Maria none
    await engine.sweep({ now: WED_10 });
    expect(assignTicket).toHaveBeenCalledWith(1, 1, 22, expect.objectContaining({ name: 'Ticket Pulse (urgent response)', role: 'automation' }), { allowAssignableOnly: false });
    const [moved] = actionsOf('moved');
    expect(moved).toMatchObject({ layer: 'raise', shadow: false, ticketId: 1, fromTechnicianId: 33, toTechnicianId: 22, fromName: 'David Zapata', toName: 'Maria Lee', priority: 4 });
    expect(moved.sentence).toBe('Moved from David Zapata to Maria Lee by the Urgent rule. Became Urgent at 10:00; David starts at 13:00. Maria is at work.');
    expect(moved.dedupeKey).toBe(`raise:1:${WED_10.toISOString()}:moved`);
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 22, moveCount: 1, chainTechnicianIds: [33] });
    expect(activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 1, activityType: 'urgent_response', performedBy: 'Ticket Pulse', details: { sentence: moved.sentence, layer: 'raise', action: 'moved', fromTechId: 33, toTechId: 22 },
    }));
    expect(tellPeople).toHaveBeenCalledTimes(1);
    expect(tellPeople.mock.calls[0][0]).toMatchObject({ workspaceId: 1, technicianIds: [33, 22], channels: ['teams', 'email'], ticket: expect.objectContaining({ id: 1 }) });
    expect(loggerMock.info).toHaveBeenCalledWith(`Urgent response: ${moved.sentence}`, { ticketId: 1, workspaceId: 1, layer: 'raise', action: 'moved', shadow: false });
  });

  test('the skill wins over the workload, and the sentence names it', async () => {
    db.tickets = [ticketRow(1, { internalCategoryId: 7, internalSubcategoryId: 70 }), ticketRow(50, { assignedTechId: 11, priority: 2 })];
    db.competencies = [{ technicianId: 11, competencyCategoryId: 70 }];
    db.categories = [{ id: 7, name: 'Network' }, { id: 70, name: 'VPN' }];
    await engine.sweep({ now: WED_10 });
    expect(actionsOf('moved')[0]).toMatchObject({ toTechnicianId: 11 });
    expect(actionsOf('moved')[0].sentence).toContain('Andrew is at work and has the VPN skill.');
  });

  test('Shadow: only the log row — nothing moves, nobody is told, no activity, and the clock ends', async () => {
    use({ mode: 'observe' });
    db.tickets = [ticketRow(1)];
    await engine.sweep({ now: WED_10 });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
    expect(db.actions).toHaveLength(1);
    expect(db.actions[0]).toMatchObject({ action: 'moved', layer: 'raise', shadow: true, fromTechnicianId: 33 });
    expect(db.actions[0].sentence.startsWith('Shadow: would have moved from David Zapata to ')).toBe(true);
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'shadow_done', ownerTechnicianId: 33, shadow: true });
    expect(ticketOf(1).assignedTechId).toBe(33);

    await engine.sweep({ now: minutes(WED_10, 1) });
    expect(db.actions).toHaveLength(1);
  });

  test('owner away and assigned by hand: tell only, the clock still applies', async () => {
    db.tickets = [ticketRow(1, { assignedBy: 'Vahid Haeri' })];
    db.episodes = [{ ticketId: 1, technicianId: 33, endedAt: null, startedAt: new Date('2026-10-14T15:00:00Z'), startMethod: 'coordinator_assigned', startAssignedByName: 'Vahid Haeri' }];
    await engine.sweep({ now: WED_10 });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(actionsOf('told_owner_away')[0]).toMatchObject({ layer: 'raise', shadow: false, fromTechnicianId: 33, toTechnicianId: null });
    expect(actionsOf('told_owner_away')[0].sentence).toBe('David Zapata is away and this ticket was assigned by hand, so it stays with them. The people at work were told.');
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 33, moveCount: 0 });
    // The people at work, not the owner who is away.
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([11, 22, 44]);
  });

  test("the pipeline's own auto-assignment is not \"by hand\", whatever the episode says", async () => {
    db.tickets = [ticketRow(1, { assignedBy: 'Service Account' })];
    db.episodes = [{ ticketId: 1, technicianId: 33, endedAt: null, startedAt: new Date('2026-10-14T15:00:00Z'), startMethod: 'coordinator_assigned', startAssignedByName: 'Service Account' }];
    db.runs = [{ id: 5, ticketId: 1, workspaceId: 1, decision: 'auto_assigned', assignedTechId: 33 }];
    await engine.sweep({ now: WED_10 });
    expect(actionsOf('moved')).toHaveLength(1);
    expect(actionsOf('told_owner_away')).toHaveLength(0);
  });

  test("raiseManualAction 'move': a hand-assigned ticket moves too", async () => {
    use({ raiseManualAction: 'move' });
    db.tickets = [ticketRow(1, { isSelfPicked: true, assignedBy: 'David Zapata' })];
    await engine.sweep({ now: WED_10 });
    expect(actionsOf('moved')).toHaveLength(1);
    expect(ticketOf(1).assignedTechId).not.toBe(33);
  });

  test('a High ticket outside the layers is not touched', async () => {
    db.tickets = [ticketRow(1, { priority: 3 })];
    await engine.sweep({ now: WED_10 });
    expect(db.clocks).toHaveLength(0);
    expect(db.actions).toHaveLength(0);
  });
});

describe('nobody at work', () => {
  test('hold: left with the owner, the contact is told, the clock waits — and it moves when somebody arrives', async () => {
    use({ nobodyContactTechnicianId: 44 });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(actionsOf('held')[0]).toMatchObject({ layer: 'raise', shadow: false, fromTechnicianId: 11 });
    expect(actionsOf('held')[0].sentence).toBe('Nobody is at work. Left with Andrew Fong; Susan Xu was told.');
    expect(clockOf(1)).toMatchObject({ state: 'waiting', ownerTechnicianId: 11, moveAt: null });
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([44]);

    // Still night: nothing new.
    await engine.sweep({ now: minutes(WED_NIGHT, 1) });
    expect(db.actions).toHaveLength(1);
    expect(tellPeople).toHaveBeenCalledTimes(1);

    // Thursday 09:05 — Andrew is on leave today, Maria is in.
    db.leaves = [{ technicianId: 11, leaveDate: new Date('2026-10-15T00:00:00Z'), category: 'OFF', status: 'APPROVED', isFullDay: true }];
    await engine.sweep({ now: THU_0905 });
    const [moved] = actionsOf('moved');
    expect(moved).toMatchObject({ layer: 'raise', fromTechnicianId: 11, toTechnicianId: 22 });
    expect(moved.sentence).toContain('Became Urgent at 23:00; Andrew is on leave.');
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 22, chainTechnicianIds: [11], moveCount: 1 });
  });

  test('hold: the owner comes on shift first — a running clock with fresh deadlines', async () => {
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(clockOf(1).state).toBe('waiting');
    await engine.sweep({ now: THU_0905 });
    expect(actionsOf('moved')).toHaveLength(0);
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 11, startedAt: THU_0905, notifyAt: minutes(THU_0905, 15), moveAt: minutes(THU_0905, 30) });
  });

  test('hold with no contact and no coordinator says that nobody was told', async () => {
    use({ coordinatorTechnicianId: null });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(actionsOf('held')[0].sentence).toBe('Nobody is at work. Left with Andrew Fong. Nobody was told: no contact is set.');
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test('on-call: assigned to the on-call person, who is texted and told', async () => {
    use({ nobodyMode: 'on_call', onCallOrder: [22] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee', email: 'maria@example.com' }, onLeaveNoCover: false });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(assignTicket).toHaveBeenCalledWith(1, 1, 22, expect.anything(), expect.anything());
    expect(textOnCall).toHaveBeenCalledWith(expect.objectContaining({ id: 22 }), expect.stringContaining('TP-1: Ticket 1'));
    expect(actionsOf('on_call_assigned')[0]).toMatchObject({ layer: 'raise', fromTechnicianId: 11, toTechnicianId: 22, details: { sms: { sent: true, reason: null } } });
    expect(actionsOf('on_call_assigned')[0].sentence).toBe('Nobody is at work. Assigned to the on-call person, Maria Lee, who was texted.');
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([22, 11]);
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 22, chainTechnicianIds: [11], moveCount: 1 });

    // Maria is the on-call person and not at work: the next sweep leaves it with her.
    await engine.sweep({ now: minutes(WED_NIGHT, 1) });
    expect(assignTicket).toHaveBeenCalledTimes(1);
  });

  test('on-call without a verified phone still assigns, and the sentence says so', async () => {
    use({ nobodyMode: 'on_call', onCallOrder: [22] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee' }, onLeaveNoCover: false });
    textOnCall.mockResolvedValue({ sent: false, reason: 'no_verified_phone' });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(actionsOf('on_call_assigned')[0].sentence).toBe('Nobody is at work. Assigned to the on-call person, Maria Lee, who has no verified phone to text.');
  });

  test('on-call on leave without cover (or nobody resolved) behaves as hold', async () => {
    use({ nobodyMode: 'on_call', onCallOrder: [22] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee' }, onLeaveNoCover: true });
    db.tickets = [ticketRow(1, { assignedTechId: 11 }), ticketRow(2, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    onCallMock.current.mockResolvedValue({ configured: false, technician: null, onLeaveNoCover: false });
    db.tickets.push(ticketRow(3, { assignedTechId: 11 }));
    await engine.sweep({ now: minutes(WED_NIGHT, 1) });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(textOnCall).not.toHaveBeenCalled();
    expect(actionsOf('held')).toHaveLength(3);
    expect(db.clocks.every((c) => c.state === 'waiting')).toBe(true);
  });

  test('the owner IS the on-call person: it waits with them, no notice', async () => {
    use({ nobodyMode: 'on_call', onCallOrder: [11] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 11, name: 'Andrew Fong' }, onLeaveNoCover: false });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(db.actions).toHaveLength(0);
    expect(clockOf(1).state).toBe('waiting');
  });

  test('Shadow on-call: a "would have" row and the clock ends', async () => {
    use({ mode: 'observe', nobodyMode: 'on_call', onCallOrder: [22] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee' }, onLeaveNoCover: false });
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    await engine.sweep({ now: WED_NIGHT });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(textOnCall).not.toHaveBeenCalled();
    expect(db.actions[0]).toMatchObject({ action: 'on_call_assigned', shadow: true });
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'shadow_done' });
  });
});

describe('layer 3: the clock', () => {
  const running = (extra = {}) => ({
    ticketId: 1, workspaceId: 1, ownerTechnicianId: 11, state: 'running', startedAt: WED_10, notifyAt: minutes(WED_10, 15), moveAt: minutes(WED_10, 30), notifiedAt: null, moveCount: 0, chainTechnicianIds: [], stoppedAt: null, stopReason: null, shadow: false, ...extra,
  });
  beforeEach(() => {
    db.tickets = [ticketRow(1, { assignedTechId: 11 })];
    db.clocks = [running()];
  });

  test.each([
    ['a note from an agent in Ticket Pulse', { entries: [{ authorType: 'agent', eventType: 'note', actorName: 'Andrew Fong', source: 'ticketpulse_user' }] }],
    ['a reply from an agent in Ticket Pulse', { entries: [{ authorType: 'agent', eventType: 'reply', actorName: 'Maria Lee', source: 'ticketpulse_user' }] }],
    ['a forward', { entries: [{ authorType: 'agent', eventType: 'forward', actorName: 'Maria Lee', source: 'ticketpulse_user' }] }],
    ['a public reply synced from FreshService', { entries: [{ authorType: null, eventType: 'public_reply', actorName: 'Andrew Fong', source: 'freshservice_conversation' }] }],
    ['a private note synced from FreshService', { entries: [{ authorType: null, eventType: 'private_note', actorName: 'Andrew Fong', source: 'freshservice_conversation' }] }],
    ['a status change by a person in FreshService', { entries: [{ authorType: null, eventType: 'status_event', actorName: 'Andrew Fong', source: 'freshservice_activity' }] }],
    ['a field change by a person in Ticket Pulse', { activities: [{ activityType: 'status_changed', performedBy: 'Andrew Fong', details: { actorKind: 'human' } }] }],
  ])('%s stops the clock', async (_label, { entries = [], activities = [] }) => {
    db.entries = entries.map((e, i) => ({ id: i + 1, ticketId: 1, incoming: false, occurredAt: minutes(WED_10, 3), ...e }));
    db.activities = activities.map((a, i) => ({ id: i + 1, ticketId: 1, performedAt: minutes(WED_10, 3), ...a }));
    const out = await engine.sweep({ now: minutes(WED_10, 20) });
    expect(out.stopped).toBe(1);
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'touched', stoppedAt: minutes(WED_10, 20) });
    expect(db.actions).toHaveLength(0);

    // Touched is final for this owner: no new cycle.
    await engine.sweep({ now: minutes(WED_10, 21) });
    expect(clockOf(1).stopReason).toBe('touched');
  });

  test.each([
    ['a reply from the requester', { entries: [{ authorType: null, eventType: 'customer_reply', actorName: 'Rita Requester', incoming: true, source: 'freshservice_conversation' }] }],
    ['a requester entry written in Ticket Pulse', { entries: [{ authorType: 'requester', eventType: 'reply', actorName: 'Rita Requester', source: 'email_inbound' }] }],
    ['a system entry', { entries: [{ authorType: 'system', eventType: 'note', actorName: 'Ticket Pulse', source: 'ticketpulse_user' }] }],
    ['an FS automation line', { entries: [{ authorType: null, eventType: 'activity', actorName: 'Supervisor', source: 'freshservice_activity' }] }],
    ["FreshService's echo of our own write (the service account)", { entries: [{ authorType: null, eventType: 'status_event', actorName: 'Service Account', source: 'freshservice_activity' }] }],
    ["the pipeline's own [Ticket Pulse] note", { entries: [{ authorType: null, eventType: 'private_note', actorName: 'Somebody Else', bodyText: '[Ticket Pulse] Assignment auto-assigned.', source: 'freshservice_conversation' }] }],
    ['the requester acting in FreshService', { entries: [{ authorType: null, eventType: 'status_event', actorName: 'Rita Requester', source: 'freshservice_activity' }] }],
    ['our own activity row', { activities: [{ activityType: 'urgent_response', performedBy: 'Ticket Pulse', details: { sentence: 'x' } }] }],
    ['an assignment by our own actor', { activities: [{ activityType: 'assigned', performedBy: 'Ticket Pulse (urgent response)', details: { actorKind: 'human' } }] }],
    ['a workflow write', { activities: [{ activityType: 'status_changed', performedBy: 'Ticket Workflow', details: { actorKind: 'workflow' } }] }],
    ['an agent note from BEFORE the clock started', { entries: [{ authorType: 'agent', eventType: 'note', actorName: 'Andrew Fong', source: 'ticketpulse_user', occurredAt: minutes(WED_10, -1) }] }],
  ])('%s does not stop it', async (_label, { entries = [], activities = [] }) => {
    db.entries = entries.map((e, i) => ({ id: i + 1, ticketId: 1, incoming: false, occurredAt: minutes(WED_10, 3), ...e }));
    db.activities = activities.map((a, i) => ({ id: i + 1, ticketId: 1, performedAt: minutes(WED_10, 3), ...a }));
    await engine.sweep({ now: minutes(WED_10, 5) });
    expect(clockOf(1).state).toBe('running');
  });

  test('threadEntryIsTouch: an agent answering from their own mailbox is "incoming" but still an agent', () => {
    const opts = { isOurs: () => false, requester: { name: 'rita requester', email: 'rita@example.com' }, countsAsRealActivity: () => true };
    expect(threadEntryIsTouch({ authorType: 'agent', eventType: 'reply', incoming: true, actorName: 'Andrew Fong' }, opts)).toBe(true);
    expect(threadEntryIsTouch({ authorType: null, eventType: 'reply', incoming: true, actorName: 'Rita Requester' }, opts)).toBe(false);
    expect(threadEntryIsTouch({ authorType: null, eventType: 'status_event', source: 'freshservice_activity', actorName: '' }, opts)).toBe(false);
  });

  test.each([
    ['priority lowered', { priority: 3 }, 'priority_lowered'],
    ['parked', { parkedUntil: new Date('2026-10-20T00:00:00Z') }, 'parked'],
    ['closed', { status: 'Closed' }, 'closed'],
    ['unassigned', { assignedTechId: null }, 'unassigned'],
  ])('%s stops the clock and nothing moves', async (_label, patch, reason) => {
    Object.assign(ticketOf(1), patch);
    await engine.sweep({ now: minutes(WED_10, 40) });
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: reason });
    expect(db.actions).toHaveLength(0);
    expect(assignTicket).not.toHaveBeenCalled();
  });

  test('the ticket is gone: the clock stops as closed', async () => {
    db.tickets = [];
    await engine.sweep({ now: minutes(WED_10, 40) });
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'closed' });
  });

  test('owner changed by a person: the old clock stops and a new cycle starts for the new owner', async () => {
    ticketOf(1).assignedTechId = 22;
    await engine.sweep({ now: minutes(WED_10, 40) });
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 22, startedAt: minutes(WED_10, 40), moveCount: 0 });
    expect(db.actions).toHaveLength(0);
  });

  test('raised again after it was lowered: a new cycle', async () => {
    db.clocks = [running({ state: 'stopped', stopReason: 'priority_lowered', stoppedAt: minutes(WED_10, 5) })];
    await engine.sweep({ now: minutes(WED_10, 40) });
    expect(clockOf(1)).toMatchObject({ state: 'running', startedAt: minutes(WED_10, 40) });
  });

  test('before the notify deadline nothing happens', async () => {
    await engine.sweep({ now: minutes(WED_10, 14) });
    expect(db.actions).toHaveLength(0);
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test('the notify deadline: the people at work are told, once', async () => {
    await engine.sweep({ now: minutes(WED_10, 15) });
    const [told] = actionsOf('team_told');
    expect(told).toMatchObject({ layer: 'clock', shadow: false, ticketId: 1, dedupeKey: `clock:1:${WED_10.toISOString()}:team_told` });
    expect(told.sentence).toBe('Urgent and untouched for 15 minutes. The people at work were told.');
    expect(clockOf(1)).toMatchObject({ state: 'running', notifiedAt: minutes(WED_10, 15) });
    expect(tellPeople).toHaveBeenCalledTimes(1);
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([11, 22, 44]); // at work now, owner included

    await engine.sweep({ now: minutes(WED_10, 16) });
    await engine.sweep({ now: minutes(WED_10, 17) });
    expect(actionsOf('team_told')).toHaveLength(1);
    expect(tellPeople).toHaveBeenCalledTimes(1);
  });

  test('a crash after the log row: the dedupe key keeps the notice to one', async () => {
    db.actions.push({ id: 99, workspaceId: 1, ticketId: 1, action: 'team_told', layer: 'clock', shadow: false, dedupeKey: `clock:1:${WED_10.toISOString()}:team_told` });
    await engine.sweep({ now: minutes(WED_10, 15) });
    expect(actionsOf('team_told')).toHaveLength(1);
    expect(tellPeople).not.toHaveBeenCalled();
  });

  test("audience 'named' and 'group' (falling back to the people at work)", async () => {
    use({ notifyAudience: 'named', notifyTechnicianIds: [44], notifyChannels: ['email'] });
    await engine.sweep({ now: minutes(WED_10, 15) });
    expect(tellPeople.mock.calls[0][0]).toMatchObject({ technicianIds: [44], channels: ['email'] });

    use({ notifyAudience: 'group' });
    db.clocks = [running()];
    db.actions = [];
    ticketOf(1).internalGroupId = 8;
    db.members = [{ groupId: 8, workspaceId: 1, technicianId: 22 }, { groupId: 8, workspaceId: 1, technicianId: 33 }];
    await engine.sweep({ now: minutes(WED_10, 15) });
    expect(tellPeople.mock.calls[1][0].technicianIds).toEqual([22, 33]);

    db.clocks = [running()];
    db.actions = [];
    db.members = [];
    await engine.sweep({ now: minutes(WED_10, 15) });
    expect(tellPeople.mock.calls[2][0].technicianIds).toEqual([11, 22, 44]);
  });

  test('the move deadline: moved to the next person at work, and the chain remembers who it left', async () => {
    db.clocks = [running({ notifiedAt: minutes(WED_10, 15) })];
    await engine.sweep({ now: minutes(WED_10, 30) });
    const [moved] = actionsOf('moved');
    expect(moved).toMatchObject({ layer: 'clock', fromTechnicianId: 11, toTechnicianId: 22 });
    expect(moved.sentence).toBe('Urgent and untouched for 30 minutes. Moved from Andrew Fong to Maria Lee: at work, fewest open tickets.');
    expect(clockOf(1)).toMatchObject({ state: 'running', ownerTechnicianId: 22, moveCount: 1, chainTechnicianIds: [11], startedAt: minutes(WED_10, 30), notifiedAt: null });

    // Half an hour later, still untouched: on to Susan — never back to Andrew.
    await engine.sweep({ now: minutes(WED_10, 60) });
    expect(actionsOf('moved')[1]).toMatchObject({ fromTechnicianId: 22, toTechnicianId: 44 });
    expect(clockOf(1)).toMatchObject({ ownerTechnicianId: 44, moveCount: 2, chainTechnicianIds: [11, 22] });
  });

  test('maxMoves reached: the coordinator gets it, is told, and the clock ends', async () => {
    db.clocks = [running({ moveCount: 2, chainTechnicianIds: [33, 22] })];
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(assignTicket).toHaveBeenCalledWith(1, 1, 44, expect.anything(), expect.anything());
    const [row] = actionsOf('coordinator');
    expect(row).toMatchObject({ layer: 'clock', fromTechnicianId: 11, toTechnicianId: 44 });
    expect(row.sentence).toBe('Urgent and still untouched after 2 moves. Assigned to the coordinator, Susan Xu, who was told.');
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'coordinator', ownerTechnicianId: 44 });
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([44, 11]);

    // The rule is done with this ticket.
    await engine.sweep({ now: minutes(WED_10, 90) });
    expect(db.actions).toHaveLength(1);
  });

  test('maxMoves 0: the clock only tells, then escalates to the coordinator', async () => {
    use({ maxMoves: 0 });
    await engine.sweep({ now: minutes(WED_10, 15) });
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(db.actions.map((a) => a.action)).toEqual(['team_told', 'coordinator']);
    expect(actionsOf('moved')).toHaveLength(0);
  });

  test('no coordinator set: it stays where it is and the sentence says so', async () => {
    use({ coordinatorTechnicianId: null });
    db.clocks = [running({ moveCount: 2 })];
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(actionsOf('coordinator')[0].sentence).toBe('Urgent and still untouched after 2 moves. No coordinator is set, so it stays with Andrew Fong.');
    expect(clockOf(1).stopReason).toBe('coordinator');
  });

  test('the coordinator already has it: told, not reassigned', async () => {
    ticketOf(1).assignedTechId = 44;
    db.clocks = [running({ ownerTechnicianId: 44, moveCount: 2 })];
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(actionsOf('coordinator')[0].sentence).toBe('Urgent and still untouched after 2 moves. It is already with the coordinator, Susan Xu, who was told.');
  });

  test('nobody else is at work at the move deadline: held, waiting, and moved when somebody arrives', async () => {
    db.leaves = [22, 44].map((id) => ({ technicianId: id, leaveDate: new Date('2026-10-14T00:00:00Z'), category: 'OFF', status: 'APPROVED', isFullDay: true }));
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(actionsOf('held')[0]).toMatchObject({ layer: 'clock', fromTechnicianId: 11 });
    expect(clockOf(1)).toMatchObject({ state: 'waiting', moveAt: minutes(WED_10, 30) });
    db.leaves = [];
    await engine.sweep({ now: minutes(WED_10, 31) });
    expect(actionsOf('moved')[0]).toMatchObject({ layer: 'clock', fromTechnicianId: 11, toTechnicianId: 22 });
  });

  test('Shadow: "would have told", then "would have moved", then the clock ends', async () => {
    use({ mode: 'observe' });
    db.clocks = [running({ shadow: true })];
    await engine.sweep({ now: minutes(WED_10, 15) });
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(db.actions.map((a) => [a.action, a.shadow])).toEqual([['team_told', true], ['moved', true]]);
    expect(db.actions[0].sentence).toBe('Shadow: would have told the people at work. Urgent and untouched for 15 minutes.');
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'shadow_done', ownerTechnicianId: 11 });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();
    expect(activityCreate).not.toHaveBeenCalled();
  });

  test('a clock started in the other mode is not finished by this one', async () => {
    db.clocks = [running({ shadow: true })];
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(actionsOf('moved')).toHaveLength(0);
    // Stopped as mode_off, then a fresh live cycle for the same ticket.
    expect(clockOf(1)).toMatchObject({ state: 'running', shadow: false, startedAt: minutes(WED_10, 30) });
  });

  test('a workspace switched off: its clocks end as mode_off', async () => {
    use({ mode: 'off' });
    await engine.sweep({ now: minutes(WED_10, 30) });
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'mode_off' });
    expect(db.actions).toHaveLength(0);
  });
});

describe('moving a FreshService ticket', () => {
  beforeEach(() => {
    db.tickets = [ticketRow(1, { origin: 'freshservice', freshserviceTicketId: 242611n, nativeNumber: null })];
  });

  test('goes through the FreshService write-back, only to people with a seat', async () => {
    db.technicians.find((t) => t.id === 22).freshserviceId = null; // Maria is a local agent
    await engine.sweep({ now: WED_10 });
    expect(assignTicket).not.toHaveBeenCalled();
    expect(updateFsTicket).toHaveBeenCalledWith(1, 1, { assignedTechId: 11 }, expect.objectContaining({ name: 'Ticket Pulse (urgent response)' }), { allowAssignableOnly: false });
    expect(actionsOf('moved')[0]).toMatchObject({ toTechnicianId: 11, details: expect.objectContaining({ via: 'freshservice_writeback' }) });
  });

  test('a refused write-back falls to the next person', async () => {
    updateFsTicket.mockRejectedValueOnce(new Error('Not a member of the group'));
    await engine.sweep({ now: WED_10 });
    expect(updateFsTicket).toHaveBeenCalledTimes(2);
    const [moved] = actionsOf('moved');
    expect(moved.toTechnicianId).toBe(updateFsTicket.mock.calls[1][2].assignedTechId);
    expect(moved.details.failedAttempts).toEqual([expect.objectContaining({ error: 'Not a member of the group' })]);
    expect(actionsOf('failed')).toHaveLength(0);
  });

  test('three refusals: a failed row, the coordinator is told, and the rule stops trying', async () => {
    updateFsTicket.mockRejectedValue(new Error('FreshService is busy'));
    await engine.sweep({ now: WED_10 });
    expect(updateFsTicket).toHaveBeenCalledTimes(3);
    const [failed] = actionsOf('failed');
    expect(failed).toMatchObject({ layer: 'raise', shadow: false, fromTechnicianId: 33 });
    expect(failed.sentence).toBe('Could not move this ticket from David Zapata: FreshService is busy.');
    expect(failed.details.attempts).toHaveLength(3);
    expect(loggerMock.warn).toHaveBeenCalledWith(`Urgent response: ${failed.sentence}`, expect.objectContaining({ ticketId: 1, action: 'failed' }));
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'failed', ownerTechnicianId: 33 });
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([44]);

    await engine.sweep({ now: minutes(WED_10, 1) });
    expect(updateFsTicket).toHaveBeenCalledTimes(3);
  });
});

describe('undo', () => {
  const ACTOR = { email: 'vhaeri@example.com', name: 'Vahid Haeri' };
  beforeEach(async () => {
    db.tickets = [ticketRow(1), ticketRow(50, { assignedTechId: 11, priority: 2 })];
    await engine.sweep({ now: WED_10 }); // moved 33 → 22 (Andrew has an open ticket, Maria none)
    jest.clearAllMocks();
  });

  test('moves the ticket back, logs it, stamps the original and stops the clock', async () => {
    const original = actionsOf('moved')[0];
    const item = await engine.undo(original.id, ACTOR, { now: minutes(WED_10, 5) });
    expect(assignTicket).toHaveBeenCalledWith(1, 1, 33, expect.objectContaining({ name: 'Ticket Pulse (urgent response)' }), { allowAssignableOnly: true });
    expect(item).toMatchObject({ id: original.id, action: 'moved', undoable: false, undoneAt: minutes(WED_10, 5), undoneBy: 'vhaeri@example.com', ticket: { id: 1, displayRef: 'TP-1', subject: 'Ticket 1' } });
    expect(db.actions.find((a) => a.id === original.id)).toMatchObject({ undoneAt: minutes(WED_10, 5), undoneBy: 'vhaeri@example.com' });
    expect(actionsOf('undone')[0]).toMatchObject({ layer: 'undo', shadow: false, undoOfId: original.id, fromTechnicianId: 22, toTechnicianId: 33, sentence: 'Moved back to David Zapata by Vahid Haeri (undo).' });
    expect(clockOf(1)).toMatchObject({ state: 'stopped', stopReason: 'undone', ownerTechnicianId: 33 });

    // The rule does not move it again.
    await engine.sweep({ now: minutes(WED_10, 6) });
    expect(ticketOf(1).assignedTechId).toBe(33);
    expect(actionsOf('moved')).toHaveLength(1);
  });

  test('409 when the ticket has moved on, when already undone, for Shadow rows and for rows that moved nothing', async () => {
    const original = actionsOf('moved')[0];
    ticketOf(1).assignedTechId = 11;
    await expect(engine.undo(original.id, ACTOR)).rejects.toMatchObject({ statusCode: 409, message: 'The ticket has moved on since: it is no longer with Maria Lee' });
    expect(assignTicket).not.toHaveBeenCalled();

    ticketOf(1).assignedTechId = 22;
    db.actions.find((a) => a.id === original.id).undoneAt = new Date();
    await expect(engine.undo(original.id, ACTOR)).rejects.toMatchObject({ statusCode: 409, message: 'This has already been undone' });

    db.actions.push({ id: 70, workspaceId: 1, ticketId: 1, action: 'moved', layer: 'raise', shadow: true, fromTechnicianId: 33, toTechnicianId: 22 });
    db.actions.push({ id: 71, workspaceId: 1, ticketId: 1, action: 'team_told', layer: 'clock', shadow: false, fromTechnicianId: 33, toTechnicianId: null });
    await expect(engine.undo(70, ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(engine.undo(71, ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    await expect(engine.undo(12345, ACTOR)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a move back that is refused leaves the row as it was', async () => {
    const original = actionsOf('moved')[0];
    assignTicket.mockRejectedValueOnce(new Error('Technician not found in this workspace'));
    await expect(engine.undo(original.id, ACTOR)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.actions.find((a) => a.id === original.id).undoneAt).toBeNull();
    expect(actionsOf('undone')).toHaveLength(0);
  });
});

describe('guardAutoAssignment (layer 1)', () => {
  const call = (extra = {}) => engine.guardAutoAssignment({ workspaceId: 1, ticket: { id: 1 }, techId: 33, assessedPriorityId: 4, runId: 700, now: WED_10, ...extra });
  beforeEach(() => {
    db.tickets = [ticketRow(1, { assignedTechId: null, priority: 2 }), ticketRow(50, { assignedTechId: 11, priority: 2 })];
  });

  test('keep: the person is at work, the priority is out of scope, the layer or the mode is off', async () => {
    expect(await call({ techId: 11 })).toEqual({ outcome: 'keep', techId: 11, sentence: null, shadow: false });
    expect((await call({ assessedPriorityId: 2 })).outcome).toBe('keep');
    use({ assignEnabled: false });
    expect((await call()).outcome).toBe('keep');
    use({ mode: 'off' });
    expect((await call()).outcome).toBe('keep');
    expect((await engine.guardAutoAssignment({ workspaceId: 7, ticket: { id: 1 }, techId: 33, assessedPriorityId: 4 })).outcome).toBe('keep');
    expect(db.actions).toHaveLength(0);
  });

  test('keep: starting within the grace minutes counts as at work', async () => {
    expect((await call({ now: at('2026-10-14', '12:40') })).outcome).toBe('keep');
    expect((await call({ now: at('2026-10-14', '12:20') })).outcome).toBe('redirect');
  });

  test('redirect (live): the best person at work, one log row, a ticket activity', async () => {
    const result = await call();
    expect(result).toMatchObject({ outcome: 'redirect', techId: 22, techName: 'Maria Lee', shadow: false });
    expect(result.sentence).toBe('Assigned to Maria Lee instead of David Zapata by the Urgent rule: David starts at 13:00.');
    expect(db.actions).toHaveLength(1);
    expect(db.actions[0]).toMatchObject({ layer: 'assign', action: 'redirected', shadow: false, priority: 4, fromTechnicianId: 33, toTechnicianId: 22, dedupeKey: 'assign:700', details: expect.objectContaining({ runId: 700 }) });
    expect(activityCreate).toHaveBeenCalledTimes(1);
    expect(db.clocks).toHaveLength(0);
  });

  test('High uses the assessed priority, not the one on the ticket; no assessed priority falls back to the ticket', async () => {
    expect((await call({ assessedPriorityId: 3 })).outcome).toBe('redirect');
    expect((await call({ assessedPriorityId: null, runId: 701 })).outcome).toBe('keep'); // the ticket is Medium
    ticketOf(1).assessedPriorityId = 4;
    expect((await call({ assessedPriorityId: null, runId: 702 })).outcome).toBe('redirect');
  });

  test('the category of the run (not saved yet) picks the person with the skill', async () => {
    db.competencies = [{ technicianId: 44, competencyCategoryId: 70 }];
    const result = await call({ ticket: { id: 1, internalCategoryId: 7, internalSubcategoryId: 70 } });
    expect(result.techId).toBe(44);
  });

  test('hold (live): nobody is at work — the contact is told', async () => {
    const result = await call({ now: WED_NIGHT, techId: 11 });
    expect(result).toMatchObject({ outcome: 'hold', techId: null, shadow: false });
    expect(result.sentence).toBe('Nobody is at work. Left for review instead of assigning it to Andrew Fong.');
    expect(db.actions[0]).toMatchObject({ layer: 'assign', action: 'held', fromTechnicianId: 11 });
    expect(tellPeople.mock.calls[0][0].technicianIds).toEqual([44]);
  });

  test('on_call (live): nobody is at work and the mode is on-call — the on-call person, texted', async () => {
    use({ nobodyMode: 'on_call', onCallOrder: [22] });
    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee' }, onLeaveNoCover: false });
    const result = await call({ now: WED_NIGHT, techId: 11 });
    expect(result).toMatchObject({ outcome: 'on_call', techId: 22, techName: 'Maria Lee', shadow: false });
    expect(textOnCall).toHaveBeenCalledTimes(1);
    expect(db.actions[0]).toMatchObject({ layer: 'assign', action: 'on_call_assigned', fromTechnicianId: 11, toTechnicianId: 22 });

    onCallMock.current.mockResolvedValue({ configured: true, technician: { id: 22, name: 'Maria Lee' }, onLeaveNoCover: true });
    expect((await call({ now: WED_NIGHT, techId: 11, runId: 703 })).outcome).toBe('hold');
  });

  test('Shadow, and a dry-run pipeline in Live: the row only', async () => {
    use({ mode: 'observe' });
    const shadow = await call();
    expect(shadow).toMatchObject({ outcome: 'redirect', techId: 22, shadow: true });
    expect(shadow.sentence.startsWith('Shadow: would have assigned to Maria Lee instead of David Zapata')).toBe(true);
    use({ mode: 'live' });
    const dry = await call({ dryRun: true, runId: 704, now: WED_NIGHT, techId: 11 });
    expect(dry).toMatchObject({ outcome: 'hold', shadow: true });
    expect(db.actions.map((a) => a.shadow)).toEqual([true, true]);
    expect(activityCreate).not.toHaveBeenCalled();
    expect(tellPeople).not.toHaveBeenCalled();
    expect(textOnCall).not.toHaveBeenCalled();
  });

  test('any error → keep, and nothing is thrown', async () => {
    settingsMock.getSettings.mockRejectedValueOnce(new Error('database is gone'));
    expect(await call()).toEqual({ outcome: 'keep', techId: 33, sentence: null, shadow: false });
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('assignment guard failed'), expect.objectContaining({ ticketId: 1 }));
    expect((await engine.guardAutoAssignment()).outcome).toBe('keep');
  });
});

describe('reads', () => {
  beforeEach(() => {
    const row = (id, action, layer, shadow, extra = {}) => ({ id, workspaceId: 1, ticketId: 1, action, layer, shadow, createdAt: new Date(`2026-10-1${id % 4}T12:00:00Z`), sentence: `s${id}`, ...extra });
    db.tickets = [ticketRow(1)];
    db.actions = [
      row(1, 'moved', 'raise', false), row(2, 'moved', 'clock', false), row(3, 'moved', 'clock', false), row(4, 'team_told', 'clock', false),
      row(5, 'moved', 'raise', true), row(6, 'redirected', 'assign', true), row(7, 'held', 'raise', true), row(8, 'undone', 'undo', false),
      row(9, 'cover_set', 'on_call', false, { ticketId: null }),
    ];
  });

  test('stats: the keys of the log, live and Shadow apart, with moved split by layer', async () => {
    const stats = await engine.stats(1, { days: 30, now: new Date('2026-10-14T18:00:00Z') });
    expect(stats).toEqual({
      days: 30,
      live: { redirected: 0, held: 0, moved: 3, toldOwnerAway: 0, teamTold: 1, coordinator: 0, onCallAssigned: 0, undone: 1, raiseMoved: 1, clockMoved: 2 },
      shadow: { redirected: 1, held: 1, moved: 1, toldOwnerAway: 0, teamTold: 0, coordinator: 0, onCallAssigned: 0, undone: 0, raiseMoved: 1, clockMoved: 0 },
    });
  });

  test('weeklySummary: the mode, the same counts, and at most five examples, live first', async () => {
    const summary = await engine.weeklySummary(1, { since: new Date('2026-10-08T00:00:00Z'), until: new Date('2026-10-15T00:00:00Z') });
    expect(summary.mode).toBe('live');
    expect(summary.live).toMatchObject({ moved: 3, raiseMoved: 1, clockMoved: 2, teamTold: 1 });
    expect(summary.shadow).toMatchObject({ moved: 1, redirected: 1, held: 1 });
    expect(summary.examples).toHaveLength(5);
    expect(summary.examples[0]).toEqual({ createdAt: expect.any(Date), sentence: expect.any(String), ticketId: 1, displayRef: 'TP-1' });
    const liveIds = [1, 2, 3, 4];
    expect(summary.examples.slice(0, 4).every((e) => liveIds.some((id) => e.sentence === `s${id}`))).toBe(true);
    expect(summary.examples[4].sentence).toMatch(/^s[567]$/);
  });

  test('clockView: only in Live, only while the clock runs or waits', async () => {
    const clock = { ticketId: 1, workspaceId: 1, ownerTechnicianId: 33, state: 'running', startedAt: WED_10, notifyAt: minutes(WED_10, 15), moveAt: minutes(WED_10, 30), notifiedAt: null, shadow: false };
    db.clocks = [clock];
    expect(await engine.clockView(1)).toEqual({ state: 'running', startedAt: WED_10, notifyAt: minutes(WED_10, 15), moveAt: minutes(WED_10, 30), notifiedAt: null, notifyMinutes: 15, moveMinutes: 30 });
    db.clocks = [{ ...clock, state: 'waiting', notifyAt: null, moveAt: null }];
    expect(await engine.clockView(1)).toMatchObject({ state: 'waiting', notifyAt: null, moveAt: null });
    db.clocks = [{ ...clock, state: 'stopped' }];
    expect(await engine.clockView(1)).toBeNull();
    db.clocks = [{ ...clock, shadow: true }];
    expect(await engine.clockView(1)).toBeNull();
    use({ mode: 'observe' });
    db.clocks = [clock];
    expect(await engine.clockView(1)).toBeNull();
    expect(await engine.clockView(999)).toBeNull();
  });
});

describe('preview', () => {
  test('a bad draft is a ValidationError; a good one is an estimate with every key', async () => {
    await expect(engine.preview(1, { clockNotifyMinutes: 40, clockMoveMinutes: 10 })).rejects.toMatchObject({ statusCode: 400 });

    db.tickets = [
      ticketRow(1, { assignedTechId: 11, assignedAt: at('2026-10-13', '10:00'), createdAt: at('2026-10-13', '10:00') }), // touched after 20 min
      ticketRow(2, { assignedTechId: 22, assignedAt: at('2026-10-13', '11:00'), createdAt: at('2026-10-13', '11:00'), status: 'Closed', closedAt: at('2026-10-13', '11:05') }), // closed in time
      ticketRow(3, { assignedTechId: 22, assignedAt: at('2026-10-13', '12:00'), createdAt: at('2026-10-13', '12:00'), priority: 2 }),
    ];
    db.entries = [{ id: 1, ticketId: 1, authorType: 'agent', eventType: 'note', occurredAt: at('2026-10-13', '10:20') }];
    db.runs = [
      { id: 1, ticketId: 3, workspaceId: 1, decision: 'auto_assigned', assignedTechId: 33, decidedAt: at('2026-10-13', '10:00') }, // Medium: out of scope
      { id: 2, ticketId: 1, workspaceId: 1, decision: 'auto_assigned', assignedTechId: 33, decidedAt: at('2026-10-13', '10:00') }, // David away, others in
      { id: 3, ticketId: 1, workspaceId: 1, decision: 'auto_assigned', assignedTechId: 11, decidedAt: at('2026-10-13', '23:00') }, // nobody in
      { id: 4, ticketId: 1, workspaceId: 1, decision: 'auto_assigned', assignedTechId: 11, decidedAt: at('2026-10-13', '10:00') }, // at work
    ];
    db.events = [
      { ticketId: 1, workspaceId: 1, fromPriorityId: 2, toPriorityId: 4, detectedAt: at('2026-10-13', '23:30') }, // Andrew away, nobody in → told
      { ticketId: 2, workspaceId: 1, fromPriorityId: 3, toPriorityId: 4, detectedAt: at('2026-10-13', '18:00') }, // Maria away, David in → moved
      { ticketId: 2, workspaceId: 1, fromPriorityId: 4, toPriorityId: 4, detectedAt: at('2026-10-13', '18:00') }, // was already in scope
    ];
    const out = await engine.preview(1, { clockNotifyMinutes: 15, clockMoveMinutes: 30 }, { days: 30, now: WED_10 });
    expect(out).toEqual({
      days: 30, estimate: true, assign: { redirected: 1, held: 1 }, raise: { moved: 1, told: 1 }, clock: { teamTold: 1, moved: 0, coordinator: 0 }, inScopeTickets: 1,
    });
  });

  test('missing data never throws: every section degrades to zero', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockRejectedValueOnce(new Error('boom'));
    prismaMock.ticketPriorityEvent.findMany.mockRejectedValueOnce(new Error('boom'));
    prismaMock.ticket.count.mockRejectedValueOnce(new Error('boom'));
    const out = await engine.preview(1, {}, { now: WED_10 });
    expect(out).toMatchObject({ estimate: true, assign: { redirected: 0, held: 0 }, raise: { moved: 0, told: 0 }, inScopeTickets: 0 });
  });
});

describe('the sweep itself', () => {
  test('re-entry guard: a second sweep while one runs is skipped', async () => {
    let release;
    prismaMock.urgentResponseSettings.findMany.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const first = engine.sweep({ now: WED_10 });
    expect(await engine.sweep({ now: WED_10 })).toEqual({ skipped: true });
    release();
    await first;
    expect((await engine.sweep({ now: WED_10 })).skipped).toBeUndefined();
  });

  test('nothing throws out of the sweep, and one bad ticket does not stop the others', async () => {
    db.tickets = [ticketRow(1, { assignedTechId: 11 }), ticketRow(2, { assignedTechId: 11 })];
    prismaMock.urgentResponseClock.upsert.mockRejectedValueOnce(new Error('deadlock'));
    const out = await engine.sweep({ now: WED_10 });
    expect(out.errors).toBe(1);
    expect(out.started).toBe(1);

    prismaMock.technician.findMany.mockRejectedValue(new Error('pool timeout'));
    prismaMock.ticket.findMany.mockRejectedValueOnce(new Error('pool timeout'));
    await expect(engine.sweep({ now: minutes(WED_10, 1) })).resolves.toMatchObject({ errors: 1 });
    prismaMock.technician.findMany.mockImplementation(async () => db.technicians.map((t) => ({ ...t })));
  });

  test('the settings table cannot be read: nothing at all is done (no clock is ended as "off")', async () => {
    db.clocks = [{ ticketId: 1, workspaceId: 1, ownerTechnicianId: 11, state: 'running', startedAt: WED_10, shadow: false }];
    prismaMock.urgentResponseSettings.findMany.mockRejectedValueOnce(new Error('relation does not exist'));
    const out = await engine.sweep({ now: WED_10 });
    expect(out.workspaces).toBe(0);
    expect(clockOf(1).state).toBe('running');
  });

  test('sandbox workspaces are never read; the on-call cover check runs at most once an hour', async () => {
    await engine.sweep({ now: WED_10 });
    expect(prismaMock.urgentResponseSettings.findMany.mock.calls[0][0].where).toEqual({ mode: { in: ['observe', 'live'] }, workspaceId: { notIn: [6, 7, 8] } });
    await engine.sweep({ now: minutes(WED_10, 1) });
    await engine.sweep({ now: minutes(WED_10, 59) });
    expect(onCallMock.dailyCoverCheck).toHaveBeenCalledTimes(1);
    expect(onCallMock.dailyCoverCheck).toHaveBeenCalledWith(1, WED_10);
    onCallMock.dailyCoverCheck.mockRejectedValueOnce(new Error('boom'));
    await expect(engine.sweep({ now: minutes(WED_10, 61) })).resolves.toMatchObject({ errors: 0 });
    expect(onCallMock.dailyCoverCheck).toHaveBeenCalledTimes(2);
  });

  test('start honours the kill switch, and stop clears the timer', () => {
    process.env.URGENT_RESPONSE_SWEEP_ENABLED = 'false';
    engine.start();
    expect(engine._timer).toBeNull();
    delete process.env.URGENT_RESPONSE_SWEEP_ENABLED;
    engine.start();
    expect(engine._timer).not.toBeNull();
    engine.stop();
    expect(engine._timer).toBeNull();
  });

  test('never the photo', async () => {
    db.tickets = [ticketRow(1)];
    await engine.sweep({ now: WED_10 });
    for (const [args] of prismaMock.technician.findMany.mock.calls) expect(args.select.photoUrl).toBeUndefined();
  });
});
