import { jest } from '@jest/globals';

/**
 * Phase 3 surface unification (Aug 2026): the draft editor UI is retired but
 * the endpoints stay admin-callable. This suite covers the two safety nets
 * that make that survivable:
 *  - publish() refuses a STALE draft (tree edited after the draft was saved)
 *    instead of silently duplicate-and-retiring live rows;
 *  - discardDraft() archives a leftover migration draft (status 'discarded').
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

const { default: skillHierarchyService } = await import('../src/services/skillHierarchyService.js');
const { ValidationError, NotFoundError } = await import('../src/utils/errors.js');

const CURRENT = [
  { id: 1, workspaceId: 1, name: 'Project Setup', parentId: null },
  { id: 2, workspaceId: 1, name: 'Quebec', parentId: 1 },
];

const DRAFT_STATE = {
  skills: [
    { id: 's1', name: 'Project Setup', sortOrder: 0, subskills: [{ id: 's1a', name: 'Quebec', sortOrder: 0 }] },
  ],
};

function resetMocks() {
  for (const model of Object.values(prismaMock)) {
    if (typeof model === 'function') continue;
    for (const fn of Object.values(model)) fn.mockReset();
  }
  prismaMock.$transaction.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
  prismaMock.competencyCategory.update.mockImplementation(async ({ where, data }) => {
    const row = CURRENT.find((r) => r.id === where.id);
    return { ...row, ...data };
  });
  let nextId = 100;
  prismaMock.competencyCategory.create.mockImplementation(async ({ data }) => ({ id: nextId++, ...data }));
  prismaMock.competencyCategory.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
  prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.skillHierarchyDraft.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
}

/** Route the drifted-rows guard query separately from the in-transaction load. */
function mockCategoryFindMany({ driftedRows = [] } = {}) {
  prismaMock.competencyCategory.findMany.mockImplementation(async (args = {}) => {
    if (args?.where?.updatedAt) return driftedRows;
    return CURRENT;
  });
}

describe('publish stale-draft guard', () => {
  beforeEach(resetMocks);

  test('a fresh draft (no tree edits after save) still publishes', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({
      id: 50,
      updatedAt: new Date('2026-08-06T12:00:00Z'),
      state: DRAFT_STATE,
      mappings: [],
    });
    mockCategoryFindMany({ driftedRows: [] });

    const result = await skillHierarchyService.publish(1, 'qa@test');

    expect(result.skillCount).toBe(1);
    expect(result.subskillCount).toBe(1);
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    // Guard queried rows changed AFTER the draft save, capped at 10 names
    const guardCall = prismaMock.competencyCategory.findMany.mock.calls
      .map(([args]) => args)
      .find((args) => args?.where?.updatedAt);
    expect(guardCall).toMatchObject({
      where: { workspaceId: 1, updatedAt: { gt: new Date('2026-08-06T12:00:00Z') } },
      take: 10,
    });
  });

  test('a draft saved BEFORE later tree edits refuses to publish, naming the drifted rows', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({
      id: 50,
      updatedAt: new Date('2026-08-01T12:00:00Z'),
      state: DRAFT_STATE,
      mappings: [],
    });
    mockCategoryFindMany({ driftedRows: [{ name: 'Renamed Row' }, { name: 'Brand-new Category' }] });

    await expect(skillHierarchyService.publish(1, 'qa@test')).rejects.toThrow(ValidationError);
    await expect(skillHierarchyService.publish(1, 'qa@test')).rejects.toThrow(
      /the taxonomy changed after this draft was saved — re-save the draft or edit via the Categories tree/,
    );
    await expect(skillHierarchyService.publish(1, 'qa@test')).rejects.toThrow(/Renamed Row, Brand-new Category/);
    // The whole-taxonomy replacement never starts
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.competencyCategory.updateMany).not.toHaveBeenCalled();
  });

  test('legacy drafts without updatedAt (mock/backfill rows) skip the guard rather than crash', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({
      id: 50,
      state: DRAFT_STATE,
      mappings: [],
    });
    prismaMock.competencyCategory.findMany.mockResolvedValue(CURRENT);

    const result = await skillHierarchyService.publish(1, 'qa@test');
    expect(result.skillCount).toBe(1);
  });
});

describe('discardDraft', () => {
  beforeEach(resetMocks);

  test('archives the newest unpublished draft as status "discarded" with the actor recorded', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue({ id: 50, status: 'draft', source: 'summit_workshop' });

    const result = await skillHierarchyService.discardDraft(1, 'admin@test');

    expect(prismaMock.skillHierarchyDraft.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 1, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
    expect(prismaMock.skillHierarchyDraft.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { status: 'discarded', updatedBy: 'admin@test' },
    });
    expect(result.status).toBe('discarded');
  });

  test('404s when there is no unpublished draft', async () => {
    prismaMock.skillHierarchyDraft.findFirst.mockResolvedValue(null);
    await expect(skillHierarchyService.discardDraft(1, 'admin@test')).rejects.toThrow(NotFoundError);
    expect(prismaMock.skillHierarchyDraft.update).not.toHaveBeenCalled();
  });

  test('refuses non-skill-hierarchy workspaces like its sibling endpoints', async () => {
    await expect(skillHierarchyService.discardDraft(999, 'admin@test')).rejects.toThrow(ValidationError);
    expect(prismaMock.skillHierarchyDraft.findFirst).not.toHaveBeenCalled();
  });
});
