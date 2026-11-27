import { jest } from '@jest/globals';
import * as v1 from './fixtures/assignmentSharesV1Ledger.js';

/**
 * Ticket shares with rules per category and internal groups (QA 11-26 #3–6).
 * Invented people: Alex (1), Sam (2), Jo (3), Kit (4); juniors Avery (5) and
 * Blake (6), Casey (7).
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  group: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
const store = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, value); }),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const calendarMock = { loadCalendar: jest.fn(async () => null) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../src/services/businessCalendarService.js', () => ({ default: calendarMock }));

const { default: shares, settingsKey } = await import('../src/services/assignmentShares/sharesService.js');
const R = await import('../src/services/assignmentShares/rules.js');

const TZ = 'America/Vancouver';
const A = 1; const S = 2; const J = 3; const K = 4; const AV = 5; const BL = 6; const CA = 7;
const JUNIORS = 70;
const NAMES = new Map([[A, 'Alex Doe'], [S, 'Sam Lee'], [J, 'Jo Park'], [K, 'Kit Moss'], [AV, 'Avery Stone'], [BL, 'Blake Ruiz'], [CA, 'Casey Ng']]);
const countOf = (picks) => picks.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
const vacation = (d) => ({ leaveDate: new Date(`${d}T00:00:00Z`), category: 'VACATION', status: 'APPROVED', isFullDay: true });

// ---- v1 → v2: the stored object Live today decides exactly as before -------------------

describe('a v1 settings object (the shape Live in a workspace today)', () => {
  // The same shape as the one stored: mode, period, 4 categories, 4 people and the extra keys. Invented values.
  const V1 = {
    v: 1, mode: 'live', period: 'week', categoryIds: [10, 11, 12, 13],
    members: [{ techId: A, pct: 40 }, { techId: S, pct: 30 }, { techId: J, pct: 20 }, { techId: K, pct: 10 }],
    enabledSince: '2026-11-02T17:00:00.000Z', updatedAt: '2026-11-16T18:00:00.000Z', updatedBy: 'Avery Stone',
    history: [{ at: '2026-11-16T18:00:00.000Z', by: 'Avery Stone', changes: [{ field: 'mode', from: 'shadow', to: 'live' }] }],
  };

  test('is read as one rule, r1, carrying its mode, period, categories, people and enabledSince', () => {
    const s = R.normalizeSettings(JSON.stringify(V1));
    expect(s).toMatchObject({ v: 2, seq: 1, fromV1: true, persisted: true, updatedBy: 'Avery Stone', history: V1.history });
    expect(s.rules).toEqual([{
      id: 'r1', name: '', mode: 'live', period: 'week', categoryIds: [10, 11, 12, 13], members: V1.members,
      groups: [], rest: { evenly: false, techIds: [] },
      enabledSince: V1.enabledSince, updatedAt: V1.updatedAt, updatedBy: 'Avery Stone',
    }]);
    expect(R.ruleFor(s, { categoryId: 12 })?.id).toBe('r1');
    expect(R.ruleFor(s, { categoryId: 99 })).toBeNull();
  });

  test('makes the same pick as the code before rules, ticket after ticket (leave, hours, hand-backs, ties)', () => {
    const rule = R.normalizeSettings(V1).rules[0];
    const { slots, people } = R.expandRule(rule, { activeIds: new Set([A, S, J, K]) });
    const zones = new Map([[A, { timezone: 'America/Vancouver' }], [S, { timezone: 'America/Toronto' }], [J, { timezone: 'America/Edmonton' }],
      [K, { timezone: 'America/Vancouver', workStartTime: '07:00', workEndTime: '15:00' }]]);
    const leavesByTech = new Map([
      [A, [vacation('2026-11-09'), vacation('2026-11-10')]],
      [S, [vacation('2026-11-04')]],
      [J, [{ leaveDate: new Date('2026-11-05T00:00:00Z'), category: 'VACATION', status: 'APPROVED', isFullDay: false, halfDayPart: 'PM' }]],
      [K, []],
    ]);
    const start = Date.parse('2026-11-02T13:00:00Z'); // Monday 05:00 Pacific
    const ticketsOld = [];
    const ticketsNew = [];
    const lastOld = new Map();
    const lastNew = new Map();
    let picks = 0;
    for (let i = 0; i < 150; i += 1) {
      const at = new Date(start + i * 89 * 60 * 1000);
      const out = new Map();
      for (const m of rule.members) if (R.onLeaveAt(leavesByTech.get(m.techId), at, TZ)) out.set(m.techId, 'on leave');
      if (i % 7 === 3) out.set(rule.members[i % 4].techId, 'handed this ticket back');
      const notWorking = new Map(rule.members.filter((m) => !out.has(m.techId) && !R.workingAt(zones.get(m.techId), at, TZ)).map((m) => [m.techId, 'outside working hours']));

      const ledgerOld = v1.buildLedger({ members: V1.members, tickets: ticketsOld, leavesByTech, timeZone: TZ });
      const ledgerNew = R.buildLedger({ members: people, slots, tickets: ticketsNew, leavesByTech, timeZone: TZ });
      expect([...ledgerNew]).toEqual([...ledgerOld]);

      const oldResult = v1.decide({ settings: V1, ledger: ledgerOld, out, notWorking, lastAssignedAt: lastOld, names: NAMES, aiPick: { techId: S } });
      const newResult = R.decide({ rule, members: people, slots, ledger: ledgerNew, out, notWorking, lastAssignedAt: lastNew, names: NAMES, aiPick: { techId: S } });
      expect(newResult).toEqual(oldResult);
      if (i % 25 === 0) {
        expect(R.previewSequence({ members: people, slots, ledger: ledgerNew, out, notWorking, lastAssignedAt: lastNew, now: at }))
          .toEqual(v1.previewSequence({ members: V1.members, ledger: ledgerOld, out, notWorking, lastAssignedAt: lastOld, now: at }));
      }
      if (!oldResult.techId) continue;
      picks += 1;
      ticketsOld.push({ holderId: oldResult.techId, at });
      ticketsNew.push({ holderId: newResult.techId, at });
      lastOld.set(oldResult.techId, at.getTime());
      lastNew.set(newResult.techId, at.getTime());
    }
    expect(picks).toBeGreaterThan(140);
  });

  test('the old splitCredit helper gives the same units', () => {
    for (const list of [[{ techId: 7, pct: 33 }, { techId: 8, pct: 33 }, { techId: 9, pct: 34 }], [{ techId: 3, pct: 50 }, { techId: 2, pct: 50 }], V1.members]) {
      expect([...R.splitCredit(list)].sort()).toEqual([...v1.splitCredit(list)].sort());
    }
  });
});

// ---- groups, the rest, validation ---------------------------------------------------------

const groupsMap = (extra = {}) => new Map([[JUNIORS, { name: 'Juniors', techIds: [AV, BL, CA] }], ...Object.entries(extra).map(([k, v]) => [Number(k), v])]);
// QA's example: Juniors take 50% of Vendor Invoices, the rest split evenly across four others.
const QA_RULE = R.normalizeRule({
  id: 'r2', name: 'Vendor Invoices', mode: 'shadow', period: 'week', categoryIds: [20],
  groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [A, S, J, K] },
});

describe('a group and the evenly split rest', () => {
  test('the group’s 50% splits evenly across its members; the rest’s 50% across its four', () => {
    const { slots, people, warnings } = R.expandRule(QA_RULE, { groups: groupsMap(), names: NAMES });
    expect(warnings).toEqual([]);
    expect(slots.map((s) => [s.key, s.pct, s.techIds])).toEqual([['g70', 50, [AV, BL, CA]], ['rest', 50, [A, S, J, K]]]);
    expect(people.find((p) => p.techId === AV)).toMatchObject({ pct: 16.7, group: 'Juniors', slotKey: 'g70' });
    expect(people.find((p) => p.techId === A)).toMatchObject({ pct: 12.5, rest: true, slotKey: 'rest' });
    const credit = R.creditSplit(slots);
    expect([...credit.values()].reduce((a, b) => a + b, 0)).toBe(R.UNIT);
    expect([credit.get(AV), credit.get(BL), credit.get(CA)]).toEqual([1667, 1667, 1666]);
    expect([A, S, J, K].map((id) => credit.get(id))).toEqual([1250, 1250, 1250, 1250]);
  });

  test('over 120 tickets the Juniors get 60 (20 each) and the other four 15 each', () => {
    const { slots, people } = R.expandRule(QA_RULE, { groups: groupsMap() });
    const picks = R.previewSequence({ members: people, slots, ledger: new Map(), count: 120 });
    const c = countOf(picks);
    expect([AV, BL, CA].map((id) => c.get(id))).toEqual([20, 20, 20]);
    expect([A, S, J, K].map((id) => c.get(id))).toEqual([15, 15, 15, 15]);
  });

  test('one junior away: the other juniors take the group’s share; all juniors away: the group earns nothing', () => {
    const { slots } = R.expandRule(QA_RULE, { groups: groupsMap() });
    const oneAway = R.creditSplit(slots, (id) => id !== AV);
    expect([oneAway.get(AV), oneAway.get(BL), oneAway.get(CA)]).toEqual([undefined, 2500, 2500]);
    const allAway = R.creditSplit(slots, (id) => ![AV, BL, CA].includes(id));
    expect([A, S, J, K].map((id) => allAway.get(id))).toEqual([2500, 2500, 2500, 2500]);
    expect(allAway.has(AV)).toBe(false);
  });

  test('a group with nobody in it is skipped, its share re-scaled over the others, with a warning', () => {
    const rule = R.normalizeRule({ mode: 'shadow', categoryIds: [20], members: [{ techId: A, pct: 30 }, { techId: S, pct: 20 }], groups: [{ groupId: JUNIORS, pct: 50 }] });
    const { slots, empty, warnings } = R.expandRule(rule, { groups: new Map([[JUNIORS, { name: 'Juniors', techIds: [] }]]) });
    expect(slots.map((s) => s.key)).toEqual(['p1', 'p2']);
    expect(empty).toEqual([{ kind: 'group', id: JUNIORS, name: 'Juniors', pct: 50 }]);
    expect(warnings[0]).toBe('Juniors has nobody who can take tickets right now, so its 50% goes to the others until someone joins.');
    const credit = R.creditSplit(slots);
    expect([credit.get(A), credit.get(S)]).toEqual([6000, 4000]);
  });

  test('an inactive group member is left out of the split', () => {
    const { slots } = R.expandRule(QA_RULE, { groups: groupsMap(), activeIds: new Set([A, S, J, K, AV, BL]) });
    expect(slots[0].techIds).toEqual([AV, BL]);
  });

  test('the pick sentence says whose share it is', () => {
    const { slots, people } = R.expandRule(QA_RULE, { groups: groupsMap(), names: NAMES });
    const out = new Map([[A, 'on leave'], [S, 'on leave'], [J, 'on leave'], [K, 'on leave']]);
    const result = R.decide({ rule: QA_RULE, members: people, slots, ledger: new Map(), out, names: NAMES });
    expect(result.techId).toBe(AV);
    expect(result.reason).toBe('furthest below their part of the Juniors share this week (0 against about 0.3)');
  });
});

describe('checks on a rule', () => {
  const ctx = { groups: groupsMap(), names: NAMES };

  test('the rest takes 100 minus the named shares', () => {
    const rule = R.normalizeRule({ categoryIds: [20], members: [{ techId: K, pct: 10 }], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [A, S, J] } });
    expect(R.explicitPct(rule)).toBe(60);
    expect(R.restPct(rule)).toBe(40);
    expect(R.validateRule({ ...rule, mode: 'shadow' }, ctx)).toEqual([]);
    expect(R.expandRule(rule, ctx).people.find((p) => p.techId === A).pct).toBe(13.3);
  });

  test('the rest needs people, and something left to split', () => {
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [] } }, ctx))
      .toContain('Pick the people who split the rest evenly');
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], groups: [{ groupId: JUNIORS, pct: 100 }], rest: { evenly: true, techIds: [A] } }, ctx))
      .toContain('The named shares already make 100%, so nothing is left to split evenly. Lower a share or stop splitting the rest');
    // No rest: the named shares must make 100 exactly.
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], groups: [{ groupId: JUNIORS, pct: 50 }] }, ctx))
      .toContain('The shares must total 100% (now 50%)');
  });

  test('a person may be in one place only, named in the message', () => {
    const errors = R.validateRule({
      mode: 'shadow', period: 'week', categoryIds: [20],
      members: [{ techId: AV, pct: 20 }], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [A, AV] },
    }, ctx);
    expect(errors).toContain('Avery Stone is on this rule more than once (named on their own, in Juniors and in the rest). Keep each person in one place');
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], members: [{ techId: A, pct: 50 }, { techId: A, pct: 50 }] }, ctx))
      .toContain('Alex Doe is named on their own twice');
  });

  test('a group must be an active internal group of the workspace, and only once', () => {
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], groups: [{ groupId: 99, pct: 100 }] }, ctx))
      .toContain('A group is not an active internal group of this workspace');
    expect(R.validateRule({ mode: 'off', period: 'week', categoryIds: [], groups: [{ groupId: JUNIORS, pct: 50 }, { groupId: JUNIORS, pct: 50 }] }, ctx))
      .toContain('Juniors is on this rule twice');
  });

  test('categories may not overlap another rule’s, with both rules named', () => {
    const parentOf = new Map([[101, 10]]);
    const categoryNames = new Map([[10, 'Project Setup'], [101, 'Quebec'], [20, 'Vendor Invoices']]);
    const setup = R.normalizeRule({ id: 'r1', categoryIds: [10] });
    expect(R.overlapErrors(R.normalizeRule({ name: 'Quebec work', categoryIds: [101] }), [setup], { parentOf, categoryNames }))
      .toEqual(['“Quebec work” and “Project Setup” both cover Project Setup › Quebec. A category can be in one rule only']);
    expect(R.overlapErrors(R.normalizeRule({ categoryIds: [20, 10] }), [setup], { parentOf, categoryNames }))
      .toEqual(['“Vendor Invoices, Project Setup” and “Project Setup” both cover Project Setup. A category can be in one rule only']);
    expect(R.overlapErrors(R.normalizeRule({ categoryIds: [20] }), [setup], { parentOf, categoryNames })).toEqual([]);
  });
});

describe('the report and preview arrangement', () => {
  test('a group is one subtotal row with its members underneath, then people, then the rest', () => {
    const rule = R.normalizeRule({ members: [{ techId: K, pct: 10 }], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [A, S] } });
    const expanded = R.expandRule(rule, { groups: new Map([[JUNIORS, { name: 'Juniors', techIds: [AV, BL] }]]) });
    const tickets = [AV, AV, BL, K, A, S, S, 99, null].map((holderId, i) => ({ id: i + 1, holderId }));
    const runs = [{ ticketId: 1, holderId: AV, share: { pick: { techId: AV } } }, { ticketId: 3, holderId: BL, share: { pick: { techId: AV } } }];
    const { rows, totals } = R.summarizeReport({ members: expanded.people, tickets, runs, names: NAMES });
    expect(totals).toMatchObject({ toMembers: 7, outside: 1, unassigned: 1 });
    const sections = R.sectionsFor(expanded, rows, { sum: ['got', 'rulePicked', 'ruleMatched'], toMembers: totals.toMembers });
    expect(sections.map((s) => s.kind)).toEqual(['group', 'people', 'rest']);
    expect(sections[0]).toMatchObject({ name: 'Juniors', pct: 50, got: 3, gotPct: 43, rulePicked: 2, ruleMatched: 1 });
    expect(sections[0].rows.map((r) => [r.name, r.pct, r.got])).toEqual([['Avery Stone', 25, 2], ['Blake Ruiz', 25, 1]]);
    expect(sections[1].rows.map((r) => r.name)).toEqual(['Kit Moss']);
    expect(sections[2]).toMatchObject({ name: 'The rest, split evenly', pct: 40, got: 3 });
    expect(sections[2].rows.map((r) => [r.name, r.pct])).toEqual([['Alex Doe', 20], ['Sam Lee', 20]]);
  });

  test('an empty group still shows, marked empty', () => {
    const rule = R.normalizeRule({ members: [{ techId: K, pct: 50 }], groups: [{ groupId: JUNIORS, pct: 50 }] });
    const expanded = R.expandRule(rule, { groups: new Map([[JUNIORS, { name: 'Juniors', techIds: [] }]]) });
    const sections = R.sectionsFor(expanded, [{ techId: K, slotKey: 'p4', count: 1 }], { sum: ['count'] });
    expect(sections[0]).toMatchObject({ kind: 'group', name: 'Juniors', empty: true, count: 0, rows: [] });
  });
});

// ---- the service: per-rule mode, groups re-read, saves ---------------------------------------

const WS = 5;
const NOW = new Date('2026-11-25T19:00:00Z'); // Wednesday 11:00 Pacific
const PEOPLE = [...NAMES].map(([id, name]) => ({ id, name, isActive: true, assignableOnly: false }));
const MEMBERS = [{ techId: A, pct: 50 }, { techId: S, pct: 20 }, { techId: J, pct: 20 }, { techId: K, pct: 10 }];
const V2 = {
  v: 2, seq: 2,
  rules: [
    { id: 'r1', mode: 'live', period: 'week', categoryIds: [10], members: MEMBERS },
    { id: 'r2', name: 'Vendor Invoices', mode: 'shadow', period: 'week', categoryIds: [20], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [S, J] } },
  ],
};
const JUNIOR_GROUP = { id: JUNIORS, name: 'Juniors', members: [{ technicianId: AV }, { technicianId: BL }] };
const ticketIn = (cat) => prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, createdAt: NOW, internalCategoryId: cat, internalSubcategoryId: null });
const apply = (extra = {}) => shares.applyToRun({
  workspaceId: WS, ticketId: 501, runId: 900, decision: 'pending_review', recommendation: { recommendations: [{ rank: 1, techId: K, techName: 'Kit Moss' }] },
  aiPick: { techId: K, techName: 'Kit Moss' }, now: NOW, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  shares._reset();
  store.set(settingsKey(WS), JSON.stringify(V2));
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: TZ });
  ticketIn(20);
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.groupBy.mockResolvedValue([]);
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue(PEOPLE);
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([
    { id: 10, name: 'Project Setup', parentId: null }, { id: 101, name: 'Quebec', parentId: 10 }, { id: 20, name: 'Vendor Invoices', parentId: null },
  ]);
  prismaMock.group.findMany.mockResolvedValue([JUNIOR_GROUP]);
  prismaMock.$queryRaw.mockResolvedValue([]);
});

describe('per-rule mode in the pipeline (QA 11-26 #5)', () => {
  test('a Vendor Invoices ticket uses the Shadow rule: a record only, naming the rule', async () => {
    const out = await apply();
    expect(out).toMatchObject({ mode: 'shadow', applied: false, step: null });
    expect(out.record).toMatchObject({ mode: 'shadow', ruleId: 'r2', applied: false });
    expect([S, J, AV, BL]).toContain(out.techId);
    // Group members are re-read from the workspace's active internal groups.
    expect(prismaMock.group.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: [JUNIORS] }, workspaceId: WS, origin: 'local', isActive: true });
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where.assignedTechId.in.sort()).toEqual([S, J, AV, BL].sort());
    expect(where.OR).toEqual([{ internalCategoryId: { in: [20] } }, { internalSubcategoryId: { in: [20] } }]);
  });

  test('a Project Setup ticket uses the Live rule at the same time', async () => {
    ticketIn(10);
    const out = await apply();
    expect(out).toMatchObject({ mode: 'live', applied: true, techId: A });
    expect(out.record.ruleId).toBe('r1');
    expect(out.step.output).toMatchObject({ ruleId: 'r1', applied: true });
    expect(prismaMock.group.findMany).not.toHaveBeenCalled();
  });

  test('a ticket in no rule’s categories is left alone', async () => {
    ticketIn(55);
    expect(await apply()).toBeNull();
  });

  test('the groups cannot be read: that rule does nothing, the AI’s pick stands', async () => {
    prismaMock.group.findMany.mockRejectedValue(new Error('db down'));
    expect(await apply()).toBeNull();
    ticketIn(10);
    expect((await apply())?.techId).toBe(A);
  });

  test('a Live pick still waiting for a reviewer counts only for its own rule (an old record with no rule id is r1’s)', async () => {
    ticketIn(10);
    prismaMock.$queryRaw.mockResolvedValue([
      { ticketId: 801, createdAt: new Date('2026-11-24T17:00:00Z'), techId: String(A), ruleId: null },
      { ticketId: 802, createdAt: new Date('2026-11-24T18:00:00Z'), techId: String(A), ruleId: 'r2' },
    ]);
    const out = await apply();
    // Alex holds one reserved r1 ticket (not two), so Sam is next.
    expect(out.record.people.find((p) => p.techId === A).count).toBe(1);
    expect(out.techId).toBe(S);
  });
});

describe('preview and report per rule (QA 11-26 #4)', () => {
  test('preview of the group rule: the next 8 tickets split 4 to the Juniors and 4 to the rest, with sections', async () => {
    const out = await shares.preview(WS, null, { ruleId: 'r2', now: NOW, count: 8 });
    expect(out.ready).toBe(true);
    expect(out.ruleId).toBe('r2');
    const c = countOf(out.picks.map((p) => p.techId));
    expect((c.get(AV) || 0) + (c.get(BL) || 0)).toBe(4);
    expect((c.get(S) || 0) + (c.get(J) || 0)).toBe(4);
    expect(out.picks.find((p) => p.techId === AV)).toMatchObject({ group: 'Juniors' });
    expect(out.sections.map((s) => [s.kind, s.name || null, s.pct || null])).toEqual([['group', 'Juniors', 50], ['rest', 'The rest, split evenly', 50]]);
    expect(out.sections[0].rows.map((r) => [r.name, r.pct])).toEqual([['Avery Stone', 25], ['Blake Ruiz', 25]]);
  });

  test('a group with nobody in it: the preview warns and the rest takes it all', async () => {
    prismaMock.group.findMany.mockResolvedValue([{ ...JUNIOR_GROUP, members: [] }]);
    const out = await shares.preview(WS, null, { ruleId: 'r2', now: NOW, count: 4 });
    expect(out.warnings).toEqual(['Juniors has nobody who can take tickets right now, so its 50% goes to the others until someone joins.']);
    expect(new Set(out.picks.map((p) => p.techId))).toEqual(new Set([S, J]));
    expect(out.sections[0]).toMatchObject({ kind: 'group', empty: true });
  });

  test('a draft for a rule not saved yet ("new") is previewed on its own', async () => {
    const out = await shares.preview(WS, { mode: 'shadow', period: 'week', categoryIds: [20], groups: [{ groupId: JUNIORS, pct: 100 }] }, { ruleId: 'new', now: NOW, count: 2 });
    expect(out.ruleId).toBeNull();
    expect(out.picks.map((p) => p.techId)).toEqual([AV, BL]);
  });

  test('the report for the group rule: a Juniors subtotal with each junior underneath', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([AV, AV, BL, S, J, J, A].map((holder, i) => ({ id: 100 + i, assignedTechId: holder, assignedBy: null, assignedTech: null })));
    const out = await shares.results(WS, { days: 14, ruleId: 'r2', now: NOW });
    expect(out.ruleId).toBe('r2');
    expect(out.totals).toMatchObject({ tickets: 7, toMembers: 6, outside: 1 });
    expect(out.sections[0]).toMatchObject({ kind: 'group', name: 'Juniors', pct: 50, got: 3, gotPct: 50 });
    expect(out.sections[0].rows.map((r) => [r.name, r.pct, r.got])).toEqual([['Avery Stone', 25, 2], ['Blake Ruiz', 25, 1]]);
    expect(out.sections[1]).toMatchObject({ kind: 'rest', pct: 50, got: 3 });
  });

  test('no rule id: the first rule, as before', async () => {
    const out = await shares.results(WS, { days: 14, now: NOW });
    expect(out.ruleId).toBe('r1');
    expect(out.sections.map((s) => s.kind)).toEqual(['people']);
  });
});

describe('saving rules', () => {
  test('a v1 object gains a second rule: stored as v2, the first rule untouched, history names the rule', async () => {
    store.set(settingsKey(WS), JSON.stringify({ v: 1, mode: 'live', period: 'week', categoryIds: [10], members: MEMBERS, enabledSince: '2026-11-02T17:00:00.000Z' }));
    const out = await shares.saveSettings(WS, {
      rule: { name: 'Vendor Invoices', mode: 'shadow', period: 'week', categoryIds: [20], groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [S, J] } },
    }, { by: 'Avery Stone', now: NOW });
    expect(out.errors).toEqual([]);
    expect(out.ruleId).toBe('r2');
    const stored = JSON.parse(store.get(settingsKey(WS)));
    expect(stored).toMatchObject({ v: 2, seq: 2 });
    expect(stored.rules[0]).toMatchObject({ id: 'r1', mode: 'live', categoryIds: [10], members: MEMBERS, enabledSince: '2026-11-02T17:00:00.000Z' });
    expect(stored.rules[1]).toMatchObject({ id: 'r2', mode: 'shadow', groups: [{ groupId: JUNIORS, pct: 50 }], rest: { evenly: true, techIds: [S, J] }, enabledSince: NOW.toISOString() });
    expect(stored.history[0]).toMatchObject({ ruleId: 'r2', rule: 'Vendor Invoices', by: 'Avery Stone' });
    expect(stored.history[0].changes[0]).toEqual({ field: 'rule', from: null, to: 'added' });
  });

  test('a rule overlapping another’s categories is refused, naming both', async () => {
    const out = await shares.saveSettings(WS, { rule: { mode: 'shadow', period: 'week', categoryIds: [101], members: [{ techId: K, pct: 100 }] } });
    expect(out.errors).toEqual(['“Quebec” and “Project Setup” both cover Project Setup › Quebec. A category can be in one rule only']);
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
  });

  test('a junior also named on their own is refused, naming them', async () => {
    const out = await shares.saveSettings(WS, { rule: { id: 'r2', members: [{ techId: AV, pct: 10 }], groups: [{ groupId: JUNIORS, pct: 40 }], rest: { evenly: true, techIds: [S, J] } } });
    expect(out.errors).toContain('Avery Stone is on this rule more than once (named on their own and in Juniors). Keep each person in one place');
  });

  test('changing one rule leaves the other alone; removing a rule keeps a history line', async () => {
    const changed = await shares.saveSettings(WS, { rule: { id: 'r2', mode: 'live' } }, { by: 'Avery Stone', now: NOW });
    expect(changed.errors).toEqual([]);
    expect(changed.settings.rules.map((r) => [r.id, r.mode])).toEqual([['r1', 'live'], ['r2', 'live']]);
    const removed = await shares.saveSettings(WS, { removeRuleId: 'r2' }, { by: 'Avery Stone', now: NOW });
    expect(removed.errors).toEqual([]);
    expect(removed.settings.rules.map((r) => r.id)).toEqual(['r1']);
    expect(removed.settings.history[0]).toMatchObject({ ruleId: 'r2', rule: 'Vendor Invoices', changes: [{ field: 'rule', to: 'removed' }] });
    // A new rule never reuses a removed rule's id.
    const added = await shares.saveSettings(WS, { rule: { mode: 'off', period: 'week', categoryIds: [20], members: [] } }, { now: NOW });
    expect(added.ruleId).toBe('r3');
  });

  test('the editor gets the active internal groups with members among the workspace’s people', async () => {
    prismaMock.technician.findMany.mockResolvedValue(PEOPLE.filter((p) => p.id !== BL));
    const { groups } = await shares.options(WS);
    expect(groups).toEqual([{ id: JUNIORS, name: 'Juniors', memberIds: [AV] }]);
    expect(prismaMock.group.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, origin: 'local', isActive: true });
  });
});
