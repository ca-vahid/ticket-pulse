import { jest } from '@jest/globals';

/**
 * Skill hierarchy under per-parent name uniqueness (Aug 2026): draft
 * normalization keeps same-named subs under DIFFERENT parents, publish keys
 * existing rows by (parent, name) so those subs update their own rows, and
 * the FreshService mirror helpers disambiguate same-named records via the
 * parent_skill lookup instead of collapsing them by bare name.
 */

const prismaMock = {
  skillHierarchyDraft: { findFirst: jest.fn(), update: jest.fn() },
  competencyCategory: { findMany: jest.fn(), update: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  technicianCompetency: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticket: { updateMany: jest.fn() },
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));

const {
  default: skillHierarchyService,
  normalizeSkillState,
  buildSubskillParentDrift,
  compareSubskillLookupMirror,
} = await import('../src/services/skillHierarchyService.js');

const record = (name, displayId, parentDisplayId = null) => ({
  data: { name, bo_display_id: displayId, ...(parentDisplayId ? { parent_skill: parentDisplayId } : {}) },
});

describe('normalizeSkillState per-parent dedupe', () => {
  test('keeps same-named subskills under different parents', () => {
    const { state, warnings } = normalizeSkillState({
      skills: [
        { id: 's1', name: 'Project Setup', subskills: [{ id: 's1a', name: 'Quebec' }] },
        { id: 's2', name: 'Accounting', subskills: [{ id: 's2a', name: 'Quebec' }] },
      ],
    });
    expect(state.skills.map((skill) => skill.subskills.map((sub) => sub.name))).toEqual([['Quebec'], ['Quebec']]);
    expect(warnings).toEqual([]);
  });

  test('still removes duplicate siblings under the SAME parent', () => {
    const { state, warnings } = normalizeSkillState({
      skills: [
        { id: 's1', name: 'Project Setup', subskills: [{ id: 'a', name: 'Quebec' }, { id: 'b', name: 'quebec' }] },
      ],
    });
    expect(state.skills[0].subskills).toHaveLength(1);
    expect(warnings).toEqual([{ type: 'duplicate_removed', level: 'subskill', name: 'quebec', parent: 'Project Setup' }]);
  });
});

describe('publish keys existing rows by (parent, name)', () => {
  const CURRENT = [
    { id: 1, workspaceId: 1, name: 'Project Setup', parentId: null },
    { id: 2, workspaceId: 1, name: 'Accounting', parentId: null },
    { id: 3, workspaceId: 1, name: 'Quebec', parentId: 1 },
    { id: 4, workspaceId: 1, name: 'Quebec', parentId: 2 },
  ];

  beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
      if (typeof model === 'function') continue;
      for (const fn of Object.values(model)) fn.mockReset();
    }
    prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
    prismaMock.competencyCategory.findMany.mockResolvedValue(CURRENT);
    prismaMock.competencyCategory.update.mockImplementation(async ({ where, data }) => {
      const row = CURRENT.find((r) => r.id === where.id);
      return { ...row, ...data };
    });
    let nextId = 100;
    prismaMock.competencyCategory.create.mockImplementation(async ({ data }) => ({ id: nextId++, ...data }));
    prismaMock.competencyCategory.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.skillHierarchyDraft.update.mockImplementation(async ({ data }) => ({ id: 50, ...data }));
  });

  test('same-named subs update their OWN rows under each parent (no cross-parent theft)', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({
      id: 50,
      state: {
        skills: [
          { id: 's1', name: 'Project Setup', sortOrder: 0, subskills: [{ id: 's1a', name: 'Quebec', sortOrder: 0 }] },
          { id: 's2', name: 'Accounting', sortOrder: 1, subskills: [{ id: 's2a', name: 'Quebec', sortOrder: 0 }] },
        ],
      },
      mappings: [],
    });

    const result = await skillHierarchyService.publish(1, 'qa@test');

    expect(prismaMock.competencyCategory.create).not.toHaveBeenCalled();
    const updates = prismaMock.competencyCategory.update.mock.calls.map(([args]) => args);
    expect(updates.find((u) => u.where.id === 3)?.data).toMatchObject({ parentId: 1 });
    expect(updates.find((u) => u.where.id === 4)?.data).toMatchObject({ parentId: 2 });
    expect(result.subskillCount).toBe(2);
  });

  test('a sub name that is ambiguous among existing rows creates a NEW row under a new parent', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({
      id: 50,
      state: {
        skills: [
          { id: 's1', name: 'Project Setup', sortOrder: 0, subskills: [{ id: 's1a', name: 'Quebec', sortOrder: 0 }] },
          { id: 's2', name: 'Accounting', sortOrder: 1, subskills: [{ id: 's2a', name: 'Quebec', sortOrder: 0 }] },
          { id: 's3', name: 'Logistics', sortOrder: 2, subskills: [{ id: 's3a', name: 'Quebec', sortOrder: 0 }] },
        ],
      },
      mappings: [],
    });

    await skillHierarchyService.publish(1, 'qa@test');

    const creates = prismaMock.competencyCategory.create.mock.calls.map(([args]) => args.data);
    expect(creates).toHaveLength(2); // new skill "Logistics" + a NEW "Quebec" under it
    const newSkill = creates.find((data) => data.name === 'Logistics');
    const newSub = creates.find((data) => data.name === 'Quebec');
    expect(newSkill.parentId).toBeNull();
    expect(newSub.parentId).toBe(100); // the freshly created Logistics id — not row 3 or 4
  });
});

describe('buildSubskillParentDrift with same-named records', () => {
  const published = {
    skills: [
      { name: 'Project Setup', subskills: [{ name: 'Quebec' }] },
      { name: 'Accounting', subskills: [{ name: 'Quebec' }] },
    ],
  };
  const skillRecords = [record('Project Setup', 11), record('Accounting', 22)];

  test('correctly-parented duplicates produce no drift', () => {
    const drift = buildSubskillParentDrift(published, skillRecords, [
      record('Quebec', 101, 11),
      record('Quebec', 102, 22),
    ]);
    expect(drift).toEqual({ missingParent: [], wrongParent: [], unresolved: [] });
  });

  test('a parentless duplicate is adopted for the unmatched parent only', () => {
    const drift = buildSubskillParentDrift(published, skillRecords, [
      record('Quebec', 101, 11),
      record('Quebec', 102), // no parent yet
    ]);
    expect(drift.missingParent).toHaveLength(1);
    expect(drift.missingParent[0]).toMatchObject({
      subskill: 'Quebec',
      expectedParent: 'Accounting',
      expectedParentDisplayId: 22,
      subskillDisplayId: 102,
    });
    expect(drift.wrongParent).toEqual([]);
  });

  test('several leftover same-named records are reported, never guessed', () => {
    const drift = buildSubskillParentDrift(published, skillRecords, [
      record('Quebec', 101, 99), // wrong parent
      record('Quebec', 102, 98), // wrong parent
    ]);
    expect(drift.wrongParent).toEqual([]);
    expect(drift.unresolved.map((item) => item.reason)).toEqual([
      'ambiguous_same_named_records',
      'ambiguous_same_named_records',
    ]);
  });

  test('single wrong-parent record still surfaces as wrongParent', () => {
    const drift = buildSubskillParentDrift(
      { skills: [{ name: 'Project Setup', subskills: [{ name: 'Quebec' }] }] },
      skillRecords,
      [record('Quebec', 101, 22)],
    );
    expect(drift.wrongParent).toHaveLength(1);
    expect(drift.wrongParent[0]).toMatchObject({ expectedParentDisplayId: 11, actualParentDisplayId: 22 });
  });
});

describe('compareSubskillLookupMirror', () => {
  const published = {
    skills: [
      { name: 'Project Setup', subskills: [{ name: 'Quebec' }] },
      { name: 'Accounting', subskills: [{ name: 'Quebec' }] },
    ],
  };
  const skillRecords = [record('Project Setup', 11), record('Accounting', 22)];

  test('per-parent duplicates reconcile one-for-one', () => {
    const drift = compareSubskillLookupMirror(published, skillRecords, [
      record('Quebec', 101, 11),
      record('Quebec', 102, 22),
    ]);
    expect(drift).toEqual({ missing: [], extra: [] });
  });

  test('one mirror record for two expected duplicates reports ONE missing', () => {
    const drift = compareSubskillLookupMirror(published, skillRecords, [
      record('Quebec', 101, 11),
    ]);
    expect(drift.missing).toEqual(['Quebec']);
    expect(drift.extra).toEqual([]);
  });

  test('parentless records satisfy a bare-name match instead of double-reporting', () => {
    const drift = compareSubskillLookupMirror(published, skillRecords, [
      record('Quebec', 101, 11),
      record('Quebec', 102), // parent not set yet — parent-drift pass adopts it
    ]);
    expect(drift).toEqual({ missing: [], extra: [] });
  });

  test('unexpected records are extra', () => {
    const drift = compareSubskillLookupMirror(published, skillRecords, [
      record('Quebec', 101, 11),
      record('Quebec', 102, 22),
      record('Ontario', 103, 11),
    ]);
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual(['Ontario']);
  });
});
