import { jest } from '@jest/globals';

/**
 * Ticket shares — the service (QA 10-16 item 4): settings in app_settings,
 * the step the pipeline calls (Shadow records, Live picks), the preview and
 * the save checks. Invented people: Alex (50), Sam (20), Jo (20), Kit (10).
 */
const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { findUnique: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  ticketLink: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};
const store = new Map();
const settingsRepositoryMock = {
  get: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
  set: jest.fn(async (key, value) => { store.set(key, value); }),
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: shares, settingsKey } = await import('../src/services/assignmentShares/sharesService.js');

const WS = 5;
const NOW = new Date('2026-10-14T18:00:00Z'); // Wednesday 11:00 Pacific
const A = 1; const S = 2; const J = 3; const K = 4;
const PEOPLE = [
  { id: A, name: 'Alex Doe', isActive: true, assignableOnly: false },
  { id: S, name: 'Sam Lee', isActive: true, assignableOnly: false },
  { id: J, name: 'Jo Park', isActive: true, assignableOnly: false },
  { id: K, name: 'Kit Moss', isActive: true, assignableOnly: false },
];
const MEMBERS = [{ techId: A, pct: 50 }, { techId: S, pct: 20 }, { techId: J, pct: 20 }, { techId: K, pct: 10 }];
const saveStored = (extra = {}) => store.set(settingsKey(WS), JSON.stringify({ v: 1, mode: 'shadow', period: 'week', categoryIds: [10], members: MEMBERS, ...extra }));
const REC = {
  internalCategoryId: 10,
  internalSubcategoryId: null,
  recommendations: [
    { rank: 1, techId: S, techName: 'Sam Lee', score: 0.9, reasoning: 'Did the last one for this client.' },
    { rank: 2, techId: J, techName: 'Jo Park', score: 0.6, reasoning: 'Also fine.' },
  ],
};
const AI = { techId: S, techName: 'Sam Lee' };
const apply = (extra = {}) => shares.applyToRun({ workspaceId: WS, ticketId: 501, runId: 900, decision: 'pending_review', recommendation: REC, aiPick: AI, now: NOW, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  shares._reset();
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Los_Angeles' });
  prismaMock.ticket.findUnique.mockResolvedValue({ id: 501, createdAt: NOW, internalCategoryId: 10, internalSubcategoryId: null });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.groupBy.mockResolvedValue([]);
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.technician.findMany.mockResolvedValue(PEOPLE);
  prismaMock.technicianLeave.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([
    { id: 10, name: 'Project Setup', parentId: null },
    { id: 11, name: 'Proposal Setup', parentId: null },
    { id: 101, name: 'Quebec', parentId: 10 },
  ]);
  prismaMock.$queryRaw.mockResolvedValue([]);
});

describe('the pipeline step', () => {
  test('Off (nothing saved): nothing is read and nothing is recorded', async () => {
    expect(await apply()).toBeNull();
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  test('Shadow: only a record of who the rule would have suggested, no step, the AI’s list untouched', async () => {
    saveStored();
    const out = await apply();
    expect(out).toMatchObject({ mode: 'shadow', applied: false, techId: A, step: null });
    expect(out.recommendations).toBeUndefined();
    expect(out.record).toMatchObject({ mode: 'shadow', applied: false, pick: { techId: A, name: 'Alex Doe' }, aiPick: { techId: S }, agreesWithAi: false });
    expect(out.record.why).toBe('Shadow: the share rule would have suggested Alex Doe, furthest below their share this week (0 against about 0.5). The AI picked Sam Lee.');
    expect(out.record.people.map((p) => [p.techId, p.count])).toEqual([[A, 0], [S, 0], [J, 0], [K, 0]]);
  });

  test('a ticket outside the chosen categories is left alone', async () => {
    saveStored();
    expect(await apply({ recommendation: { ...REC, internalCategoryId: 11 } })).toBeNull();
  });

  test('a subcategory of a chosen top category is covered', async () => {
    saveStored({ categoryIds: [10] });
    const out = await apply({ recommendation: { ...REC, internalCategoryId: 10, internalSubcategoryId: 101 } });
    expect(out?.techId).toBe(A);
  });

  test('counts come from this week’s tickets: Alex already has hers, so Sam is next', async () => {
    saveStored();
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 11, assignedTechId: A, createdAt: new Date('2026-10-13T16:00:00Z') },
      { id: 12, assignedTechId: A, createdAt: new Date('2026-10-13T17:00:00Z') },
    ]);
    const out = await apply();
    expect(out.techId).toBe(S);
    expect(out.record.agreesWithAi).toBe(true);
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: WS, isNoise: false, status: { not: 'Deleted' }, assignedTechId: { in: [A, S, J, K] } });
    expect(where.createdAt.gte.toISOString()).toBe('2026-10-12T07:00:00.000Z');
  });

  test('a duplicate or merged ticket does not count', async () => {
    saveStored();
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 11, assignedTechId: A, createdAt: new Date('2026-10-13T16:00:00Z') }]);
    prismaMock.ticketLink.findMany.mockResolvedValue([{ ticketId: 11 }]);
    expect((await apply()).techId).toBe(A);
  });

  test('someone on leave today is skipped', async () => {
    saveStored();
    prismaMock.technicianLeave.findMany.mockResolvedValue([
      { technicianId: A, leaveDate: new Date('2026-10-14T00:00:00Z'), category: 'VACATION', status: 'APPROVED', isFullDay: true },
    ]);
    const out = await apply();
    expect(out.techId).toBe(S);
    expect(out.record.people.find((p) => p.techId === A).out).toBe('on leave');
  });

  test('someone who handed this ticket back is skipped for it', async () => {
    saveStored();
    prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([{ technicianId: A }]);
    expect((await apply()).techId).toBe(S);
  });

  test('everyone away: no pick, the AI’s pick stands', async () => {
    saveStored({ mode: 'live' });
    prismaMock.technician.findMany.mockResolvedValue(PEOPLE.map((p) => ({ ...p, isActive: false })));
    const out = await apply();
    expect(out).toMatchObject({ applied: false, techId: null });
    expect(out.recommendations).toBeUndefined();
    expect(out.sentence).toBe('Nobody on the share list is in, so the AI’s pick stands.');
  });

  test('Live, suggest-only: the rule’s pick is rank 1 and the AI’s own pick second, with a step', async () => {
    saveStored({ mode: 'live' });
    const out = await apply();
    expect(out).toMatchObject({ mode: 'live', applied: true, techId: A });
    expect(out.recommendations.map((r) => [r.rank, r.techId])).toEqual([[1, A], [2, S], [3, J]]);
    expect(out.step).toMatchObject({ stepName: 'share_rule', output: { kind: 'share_rule', applied: true, fromTechId: S, toTechId: A } });
    expect(out.sentence).toBe('Suggested first by the share rule: Alex Doe, furthest below their share this week (0 against about 0.5). The AI’s own first choice, Sam Lee, is second.');
  });

  test('Live, auto-assign: the rule sets the person', async () => {
    saveStored({ mode: 'live' });
    const out = await apply({ decision: 'auto_assigned' });
    expect(out).toMatchObject({ applied: true, techId: A });
    expect(out.recommendations).toBeUndefined();
    expect(out.sentence).toMatch(/^Assigned by the share rule to Alex Doe, furthest below/);
  });

  test('Live: two tickets at once do not both go to the same person (the first pick is held)', async () => {
    saveStored({ mode: 'live' });
    const first = await apply({ ticketId: 501 });
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 502, createdAt: NOW, internalCategoryId: 10 });
    const second = await apply({ ticketId: 502 });
    expect([first.techId, second.techId]).toEqual([A, S]);
  });

  test('Live, but the pipeline is in dry-run: Shadow only', async () => {
    saveStored({ mode: 'live' });
    const out = await apply({ dryRun: true });
    expect(out).toMatchObject({ mode: 'shadow', applied: false, step: null });
  });

  test('settings that cannot be read: the rule does nothing', async () => {
    settingsRepositoryMock.get.mockRejectedValueOnce(new Error('db down'));
    expect(await apply()).toBeNull();
  });

  test('anything else failing: null (the AI’s pick stands), never a throw', async () => {
    saveStored({ mode: 'live' });
    const spy = jest.spyOn(shares, '_state').mockRejectedValueOnce(new Error('boom'));
    await expect(apply()).resolves.toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith('Ticket shares: the rule failed, the AI’s pick stands', expect.objectContaining({ error: 'boom' }));
    spy.mockRestore();
  });

  test('integration sandboxes are never touched', async () => {
    store.set(settingsKey(7), JSON.stringify({ mode: 'live', categoryIds: [10], members: MEMBERS }));
    expect(await apply({ workspaceId: 7 })).toBeNull();
  });
});

describe('settings and preview', () => {
  test('a save that does not total 100 is refused and nothing is written', async () => {
    const out = await shares.saveSettings(WS, { mode: 'shadow', categoryIds: [10], members: [{ techId: A, pct: 50 }, { techId: S, pct: 40 }] });
    expect(out.errors).toContain('The shares must total 100% (now 90%)');
    expect(settingsRepositoryMock.set).not.toHaveBeenCalled();
  });

  test('a person outside the workspace is refused', async () => {
    const out = await shares.saveSettings(WS, { mode: 'shadow', categoryIds: [10], members: [{ techId: 77, pct: 100 }] });
    expect(out.errors).toContain('Someone on the list is not an active member of this workspace');
  });

  test('a good save is stored under assignment_shares_ws<id> and read back', async () => {
    const out = await shares.saveSettings(WS, { mode: 'shadow', categoryIds: [10, 101], members: MEMBERS }, { by: 'Alex Doe', now: NOW });
    expect(out.errors).toEqual([]);
    expect(settingsRepositoryMock.set).toHaveBeenCalledWith('assignment_shares_ws5', expect.any(String));
    expect(JSON.parse(store.get('assignment_shares_ws5'))).toMatchObject({ v: 1, mode: 'shadow', period: 'week', categoryIds: [10, 101] });
    expect(out.settings).toMatchObject({ mode: 'shadow', updatedBy: 'Alex Doe' });
  });

  test('the editor gets top categories with their subcategories', async () => {
    const { categories, people } = await shares.options(WS);
    expect(categories).toEqual([
      { id: 10, name: 'Project Setup', subcategories: [{ id: 101, name: 'Quebec' }] },
      { id: 11, name: 'Proposal Setup', subcategories: [] },
    ]);
    expect(people).toHaveLength(4);
  });

  test('preview of a draft: the next 10 tickets, with names', async () => {
    const out = await shares.preview(WS, { period: 'week', categoryIds: [10], members: MEMBERS }, { now: NOW });
    expect(out.ready).toBe(true);
    expect(out.picks.map((p) => p.name)).toEqual(['Alex Doe', 'Sam Lee', 'Jo Park', 'Alex Doe', 'Alex Doe', 'Kit Moss', 'Alex Doe', 'Sam Lee', 'Jo Park', 'Alex Doe']);
  });

  test('preview of a draft that does not total 100: not ready, no picks', async () => {
    const out = await shares.preview(WS, { period: 'week', categoryIds: [10], members: [{ techId: A, pct: 30 }] }, { now: NOW });
    expect(out).toMatchObject({ ready: false, picks: [] });
  });
});
