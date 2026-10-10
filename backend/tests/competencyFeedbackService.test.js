import { jest } from '@jest/globals';

/**
 * Skills learner (QA 10-09 item 12): a skill is learned when a ticket is
 * CLOSED, for the person holding it — basic at 1 closed ticket in the
 * category, intermediate at 10, advanced at 25, never expert — and never from
 * an assignment decision. Plus the admin review of learner rows.
 *
 * Earlier guards still pinned here: the per-workspace kill switch (Coreshack,
 * Aug 2026) and "a person who never held a ticket learns nothing" (Sep 2026).
 */

const prismaMock = {
  assignmentConfig: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  ticket: { findUnique: jest.fn() },
  ticketLink: { findFirst: jest.fn() },
  technicianCompetency: {
    findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(),
    create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};
const statusServiceMock = { listStatuses: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: statusServiceMock,
  TERMINAL_BASE_STATUSES: ['Resolved', 'Closed'],
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  default: learner,
  COMPETENCY_LEARNING,
  PROFICIENCY_LEVELS,
  levelForClosedCount,
  isLearnedNote,
} = await import('../src/services/competencyFeedbackService.js');

const TECH = 48;
const CATEGORY = 92;

const closedTicket = (over = {}) => ({
  id: 700,
  workspaceId: 1,
  status: 'Closed',
  isNoise: false,
  assignedTechId: TECH,
  resolvedByKind: 'human',
  resolutionReason: null,
  internalCategoryId: CATEGORY,
  internalSubcategoryId: null,
  assignedTech: { id: TECH, workspaceId: 1, isActive: true, assignableOnly: false },
  ...over,
});

/** The grouped evidence query answers with `closed` tickets for the pair. */
const evidence = (closed, aiAssigned = 0, over = {}) => prismaMock.$queryRaw.mockResolvedValue(
  closed > 0 ? [{ technicianId: TECH, categoryId: CATEGORY, subcategoryId: null, closed, aiAssigned, ...over }] : [],
);

beforeEach(() => {
  jest.clearAllMocks();
  statusServiceMock.listStatuses.mockResolvedValue([
    { name: 'Open', baseStatus: 'Open' },
    { name: 'Resolved', baseStatus: 'Resolved' },
    { name: 'Closed', baseStatus: 'Closed' },
    { name: 'Done', baseStatus: 'Resolved' },
  ]);
  prismaMock.ticket.findUnique.mockResolvedValue(closedTicket());
  prismaMock.assignmentConfig.findUnique.mockResolvedValue({ competencyFeedbackEnabled: true });
  prismaMock.competencyCategory.findFirst.mockResolvedValue({ id: CATEGORY, name: 'New hires' });
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.technicianCompetency.findUnique.mockResolvedValue(null);
  prismaMock.technicianCompetency.create.mockResolvedValue({ id: 1 });
  prismaMock.technicianCompetency.update.mockResolvedValue({ id: 1 });
  evidence(1);
});

const noWrites = () => {
  expect(prismaMock.technicianCompetency.create).not.toHaveBeenCalled();
  expect(prismaMock.technicianCompetency.update).not.toHaveBeenCalled();
};

describe('thresholds', () => {
  test('one exported constant: basic 1, intermediate 10, advanced 25, never expert', () => {
    expect(COMPETENCY_LEARNING.thresholds).toEqual({ basic: 1, intermediate: 10, advanced: 25 });
    expect(COMPETENCY_LEARNING.maxAutoLevel).toBe('advanced');
    expect(PROFICIENCY_LEVELS).toContain('expert');
  });

  test('levelForClosedCount follows the bars and stops at advanced', () => {
    expect(levelForClosedCount(0)).toBeNull();
    expect(levelForClosedCount(1)).toBe('basic');
    expect(levelForClosedCount(9)).toBe('basic');
    expect(levelForClosedCount(10)).toBe('intermediate');
    expect(levelForClosedCount(24)).toBe('intermediate');
    expect(levelForClosedCount(25)).toBe('advanced');
    expect(levelForClosedCount(5000)).toBe('advanced');
  });

  test('the note keeps the "Auto-created" prefix the matrix marker looks for', () => {
    expect(COMPETENCY_LEARNING.createdNote).toBe('Auto-created from closed tickets');
    expect(isLearnedNote(COMPETENCY_LEARNING.createdNote)).toBe(true);
    expect(isLearnedNote('Auto-created from assignment feedback')).toBe(true);
    expect(isLearnedNote('Confirmed by ada@example.com')).toBe(false);
    expect(isLearnedNote(null)).toBe(false);
  });
});

describe('no learning at assignment time', () => {
  test.each(['approved', 'modified', 'auto_assigned'])('a %s decision reads and writes nothing', async (decision) => {
    const out = await learner.processDecisionFeedback(101, decision, TECH, 1);
    expect(out).toEqual({ learned: false, reason: 'learning_happens_on_close' });
    expect(prismaMock.assignmentPipelineRun.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPipelineRun.update).not.toHaveBeenCalled();
    expect(prismaMock.assignmentConfig.findUnique).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('learning on close', () => {
  test('the first closed ticket in a category creates a basic skill for the holder', async () => {
    const out = await learner.processTicketClosed(700, 1);

    expect(out).toMatchObject({ learned: true, action: 'created', level: 'basic', closed: 1 });
    expect(prismaMock.technicianCompetency.create).toHaveBeenCalledWith({
      data: {
        technicianId: TECH,
        workspaceId: 1,
        competencyCategoryId: CATEGORY,
        proficiencyLevel: 'basic',
        notes: 'Auto-created from closed tickets',
      },
    });
  });

  test('the subcategory is credited when the ticket has one', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(closedTicket({ internalSubcategoryId: 93 }));
    prismaMock.competencyCategory.findFirst.mockResolvedValue({ id: 93, name: 'Accounts' });
    evidence(1, 0, { subcategoryId: 93 });

    await learner.processTicketClosed(700, 1);

    expect(prismaMock.competencyCategory.findFirst.mock.calls[0][0].where).toMatchObject({ id: 93, workspaceId: 1, isActive: true });
    expect(prismaMock.technicianCompetency.create.mock.calls[0][0].data.competencyCategoryId).toBe(93);
  });

  test('9 closed tickets is still basic: nothing changes', async () => {
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'basic', notes: 'Auto-created from closed tickets' });
    evidence(9);
    const out = await learner.processTicketClosed(700, 1);
    expect(out).toEqual({ learned: false, reason: 'level_already_held' });
    noWrites();
  });

  test('the 10th closed ticket promotes to intermediate', async () => {
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'basic', notes: 'Auto-created from closed tickets' });
    evidence(10);
    const out = await learner.processTicketClosed(700, 1);
    expect(out).toMatchObject({ learned: true, action: 'promoted', from: 'basic', level: 'intermediate', closed: 10 });
    expect(prismaMock.technicianCompetency.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { proficiencyLevel: 'intermediate' } });
  });

  test('24 closed tickets stays intermediate; the 25th promotes to advanced', async () => {
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'intermediate', notes: 'Auto-created from closed tickets' });
    evidence(24);
    await learner.processTicketClosed(700, 1);
    noWrites();

    evidence(25);
    const out = await learner.processTicketClosed(700, 1);
    expect(out).toMatchObject({ action: 'promoted', from: 'intermediate', level: 'advanced' });
    expect(prismaMock.technicianCompetency.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { proficiencyLevel: 'advanced' } });
  });

  test('a level a person set is never raised by the learner', async () => {
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'basic', notes: null });
    evidence(40);
    const out = await learner.processTicketClosed(700, 1);
    expect(out).toEqual({ learned: false, reason: 'set_by_person' });
    noWrites();
  });

  test('expert is never granted, however many tickets are closed', async () => {
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'advanced', notes: null });
    evidence(900);
    await learner.processTicketClosed(700, 1);
    noWrites();
  });

  test('never demotes, and never touches a level a person set higher', async () => {
    for (const level of ['intermediate', 'advanced', 'expert']) {
      prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: level, notes: null });
      evidence(1);
      await learner.processTicketClosed(700, 1);
    }
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'expert', notes: null });
    evidence(30);
    await learner.processTicketClosed(700, 1);
    noWrites();
  });

  test('idempotent: the same ticket closed again (reopen, or the sync seeing it twice) counts once', async () => {
    await learner.processTicketClosed(700, 1);
    expect(prismaMock.technicianCompetency.create).toHaveBeenCalledTimes(1);

    // Second close of the SAME ticket: the count read from the tickets table is still 1.
    prismaMock.technicianCompetency.findUnique.mockResolvedValue({ id: 5, proficiencyLevel: 'basic', notes: 'Auto-created from closed tickets' });
    for (let i = 0; i < 12; i += 1) await learner.processTicketClosed(700, 1);

    expect(prismaMock.technicianCompetency.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.technicianCompetency.update).not.toHaveBeenCalled();
  });

  test('two closes racing to create the same row: the loser is quiet', async () => {
    prismaMock.technicianCompetency.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason: 'already_created' });
  });

  test('a failure never throws', async () => {
    prismaMock.ticket.findUnique.mockRejectedValue(new Error('db down'));
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason: 'error' });
  });
});

describe('what never earns a skill', () => {
  const skips = [
    ['noise', { isNoise: true }, 'noise'],
    ['a ticket closed with no assignee', { assignedTechId: null, assignedTech: null }, 'unassigned'],
    ['an "other teams" (assignable-only) person', { assignedTech: { id: TECH, workspaceId: 1, isActive: false, assignableOnly: true } }, 'assignable_only'],
    ['an inactive technician', { assignedTech: { id: TECH, workspaceId: 1, isActive: false, assignableOnly: false } }, 'inactive_technician'],
    ['a duplicate', { resolutionReason: 'duplicate' }, 'duplicate'],
    ['a ticket closed by a workflow', { resolvedByKind: 'workflow' }, 'closed_by_automation'],
    ['a ticket closed through the API', { resolvedByKind: 'api' }, 'closed_by_automation'],
    ['a ticket Auto-help resolved', { resolvedByKind: 'auto_help' }, 'closed_by_automation'],
    ['a ticket with no internal category', { internalCategoryId: null, internalSubcategoryId: null }, 'no_category'],
    ['a ticket that is not closed any more', { status: 'Open' }, 'not_closed'],
  ];
  test.each(skips)('%s', async (_label, over, reason) => {
    prismaMock.ticket.findUnique.mockResolvedValue(closedTicket(over));
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason });
    noWrites();
  });

  test('a ticket linked as a duplicate of another', async () => {
    prismaMock.ticketLink.findFirst.mockResolvedValue({ id: 3 });
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason: 'duplicate' });
    noWrites();
  });

  test('the workspace switch off: nothing is created or promoted', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ competencyFeedbackEnabled: false });
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason: 'learning_disabled' });
    noWrites();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  test('a missing config row behaves as enabled', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue(null);
    await learner.processTicketClosed(700, 1);
    expect(prismaMock.technicianCompetency.create).toHaveBeenCalled();
  });

  test('a category retired or in another workspace', async () => {
    prismaMock.competencyCategory.findFirst.mockResolvedValue(null);
    await expect(learner.processTicketClosed(700, 1)).resolves.toEqual({ learned: false, reason: 'no_category' });
    noWrites();
  });

  test('a custom Resolved-base status ("Done") counts as closed', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(closedTicket({ status: 'Done' }));
    await learner.processTicketClosed(700, 1);
    expect(prismaMock.technicianCompetency.create).toHaveBeenCalled();
  });
});

describe('closed-ticket evidence', () => {
  test('a ticket in a subcategory is a closed ticket in the subcategory and in its parent', () => {
    const lookup = learner._evidenceLookup([
      { technicianId: 1, categoryId: 10, subcategoryId: 11, closed: 4, aiAssigned: 3 },
      { technicianId: 1, categoryId: 10, subcategoryId: 12, closed: 2, aiAssigned: 0 },
      { technicianId: 1, categoryId: 10, subcategoryId: null, closed: 1, aiAssigned: 1 },
      { technicianId: 2, categoryId: 10, subcategoryId: 11, closed: 9, aiAssigned: 9 },
    ]);
    expect(lookup(1, 10)).toEqual({ closed: 7, aiAssigned: 4 });
    expect(lookup(1, 11)).toEqual({ closed: 4, aiAssigned: 3 });
    expect(lookup(2, 11)).toEqual({ closed: 9, aiAssigned: 9 });
    expect(lookup(3, 10)).toEqual({ closed: 0, aiAssigned: 0 });
  });

  test('no people or no categories: no query', async () => {
    expect(await learner.closedTicketEvidence(1, [], [5])).toEqual([]);
    expect(await learner.closedTicketEvidence(1, [5], [])).toEqual([]);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  test('one grouped query, parameterised with the workspace terminal statuses and the automation kinds', async () => {
    await learner.closedTicketEvidence(1, [TECH], [CATEGORY]);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toMatch(/GROUP BY/);
    expect(sql).not.toMatch(/photo/i);
    expect(values).toContainEqual(expect.arrayContaining(['Resolved', 'Closed', 'Done']));
    expect(values).toContainEqual(['workflow', 'api', 'automation', 'auto_help']);
    expect(values).toContainEqual(['auto_assigned', 'approved']);
  });
});

describe('admin review of learned skills', () => {
  const row = (id, technicianId, competencyCategoryId, proficiencyLevel, name) => ({
    id, technicianId, competencyCategoryId, proficiencyLevel,
    notes: 'Auto-created from assignment feedback',
    createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    technician: { id: technicianId, name, email: `${name}@example.com`, isActive: true, assignableOnly: false },
    competencyCategory: { id: competencyCategoryId, name: `Cat ${competencyCategoryId}`, parentId: 10, isActive: true, parent: { id: 10, name: 'Parent' } },
  });

  test('lists learner rows only, with evidence, weakest first', async () => {
    prismaMock.technicianCompetency.findMany.mockResolvedValue([
      row(1, 7, 11, 'basic', 'Ava'), // 4 closed / 1 asked
      row(2, 7, 12, 'advanced', 'Ava'), // 2 closed / 25 asked  ← weakest
      row(3, 8, 11, 'intermediate', 'Ben'), // 9 closed / 10 asked
    ]);
    prismaMock.$queryRaw.mockResolvedValue([
      { technicianId: 7, categoryId: 10, subcategoryId: 11, closed: 4, aiAssigned: 1 },
      { technicianId: 7, categoryId: 10, subcategoryId: 12, closed: 2, aiAssigned: 2 },
      { technicianId: 8, categoryId: 10, subcategoryId: 11, closed: 9, aiAssigned: 0 },
    ]);

    const out = await learner.listLearnedSkills(1);

    const where = prismaMock.technicianCompetency.findMany.mock.calls[0][0];
    expect(where.where).toEqual({ workspaceId: 1, notes: { startsWith: 'Auto-created' } });
    // Photos come from the roster the page already has — never per row here.
    expect(JSON.stringify(where.select)).not.toMatch(/photo/i);

    expect(out.items.map((i) => i.id)).toEqual([2, 3, 1]);
    expect(out.items[0]).toMatchObject({
      level: 'advanced',
      technician: { id: 7, name: 'Ava' },
      category: { id: 12, name: 'Cat 12', parentName: 'Parent' },
      evidence: { closed: 2, aiAssigned: 2, expectedForLevel: 25, belowBar: true },
    });
    expect(out.items[2].evidence).toEqual({ closed: 4, aiAssigned: 1, expectedForLevel: 1, belowBar: false });
    expect(out).toMatchObject({ total: 3, belowBar: 2, thresholds: { basic: 1, intermediate: 10, advanced: 25 }, learningEnabled: true });
    expect(out.levels).toEqual(['basic', 'intermediate', 'advanced', 'expert']);
  });

  test('keep clears the marker, scoped to the workspace and to learner rows', async () => {
    prismaMock.technicianCompetency.updateMany.mockResolvedValue({ count: 2 });
    const out = await learner.keepLearnedSkills(1, [4, '5', 5], 'ada@example.com');

    expect(out).toEqual({ kept: 2, requested: 2 });
    const args = prismaMock.technicianCompetency.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: { in: [4, 5] }, workspaceId: 1, notes: { startsWith: 'Auto-created' } });
    expect(args.data.notes).toMatch(/^Confirmed by ada@example\.com on \d{4}-\d{2}-\d{2}/);
    expect(isLearnedNote(args.data.notes)).toBe(false);
  });

  test('remove deletes only learner rows of this workspace', async () => {
    prismaMock.technicianCompetency.deleteMany.mockResolvedValue({ count: 1 });
    const out = await learner.removeLearnedSkills(1, [4, 9], 'ada@example.com');
    expect(out).toEqual({ removed: 1, requested: 2 });
    expect(prismaMock.technicianCompetency.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [4, 9] }, workspaceId: 1, notes: { startsWith: 'Auto-created' } },
    });
  });

  test.each([[undefined], ['4'], [[]], [['x', 0, -2]]])('ids %p are refused before any write', async (ids) => {
    await expect(learner.keepLearnedSkills(1, ids, 'a@x.io')).rejects.toThrow(/ids/);
    await expect(learner.removeLearnedSkills(1, ids, 'a@x.io')).rejects.toThrow(/ids/);
    expect(prismaMock.technicianCompetency.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.technicianCompetency.deleteMany).not.toHaveBeenCalled();
  });

  test('more than 500 ids in one request is refused', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    await expect(learner.removeLearnedSkills(1, ids, 'a@x.io')).rejects.toThrow(/At most 500/);
  });

  test('setting the level confirms the row; expert is allowed for a person', async () => {
    prismaMock.technicianCompetency.findFirst.mockResolvedValue({ id: 4, proficiencyLevel: 'advanced' });
    prismaMock.technicianCompetency.update.mockImplementation(({ data }) => Promise.resolve({ id: 4, ...data }));

    const out = await learner.setLearnedSkillLevel(1, '4', 'Expert', 'ada@example.com');

    expect(out).toEqual({ id: 4, level: 'expert', from: 'advanced' });
    expect(prismaMock.technicianCompetency.findFirst.mock.calls[0][0].where).toEqual({ id: 4, workspaceId: 1, notes: { startsWith: 'Auto-created' } });
    const { data } = prismaMock.technicianCompetency.update.mock.calls[0][0];
    expect(data.proficiencyLevel).toBe('expert');
    expect(isLearnedNote(data.notes)).toBe(false);
  });

  test('an unknown level, or a row that is not a learner row here, is refused', async () => {
    await expect(learner.setLearnedSkillLevel(1, 4, 'guru', 'a@x.io')).rejects.toThrow(/level must be one of/);
    prismaMock.technicianCompetency.findFirst.mockResolvedValue(null);
    await expect(learner.setLearnedSkillLevel(1, 4, 'basic', 'a@x.io')).rejects.toThrow(/not found/i);
    expect(prismaMock.technicianCompetency.update).not.toHaveBeenCalled();
  });
});
