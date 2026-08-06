import { jest } from '@jest/globals';

/**
 * Categories overhaul (Aug 2026): names are unique PER PARENT via two partial
 * unique indexes (competency_categories_ws_name_toplevel_key /
 * competency_categories_ws_parent_name_key — migration
 * 20260806200000_category_scoped_names). A local probe against Prisma 5.22
 * confirmed violations of these raw indexes still surface as P2002 with
 * meta.target = DB column names. These tests cover the friendly conflict
 * errors, rename side-effects on denormalized ticket fields, merge hardening
 * (ticket remap + level guards — the July 2026 orphaning incident class), and
 * the categoriesDetailed read contract.
 */

const prismaMock = {
  competencyCategory: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    groupBy: jest.fn(),
  },
  technicianCompetency: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
    groupBy: jest.fn(),
  },
  ticket: {
    count: jest.fn(),
    updateMany: jest.fn(),
    groupBy: jest.fn(),
  },
  categoryGroupLink: {
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(async (fn) => fn(prismaMock)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: competencyRepository } = await import('../src/services/competencyRepository.js');
const { ValidationError } = await import('../src/utils/errors.js');

// What Prisma 5.22 actually throws for the raw partial indexes (probed locally).
function p2002(target) {
  const error = new Error(`Unique constraint failed on the fields: (${target.join(', ')})`);
  error.name = 'PrismaClientKnownRequestError';
  error.code = 'P2002';
  error.meta = { modelName: 'CompetencyCategory', target };
  return error;
}

beforeEach(() => {
  for (const model of Object.values(prismaMock)) {
    if (typeof model === 'function') continue;
    for (const fn of Object.values(model)) fn.mockReset();
  }
  prismaMock.$transaction.mockImplementation(async (fn) => fn(prismaMock));
});

describe('create/update duplicate names → friendly ValidationError', () => {
  test('duplicate top-level create reports the workspace-scoped message', async () => {
    prismaMock.competencyCategory.create.mockRejectedValue(p2002(['workspace_id', 'name']));

    await expect(competencyRepository.createCategory(1, { name: 'Accounting' }))
      .rejects.toThrow(ValidationError);
    prismaMock.competencyCategory.create.mockRejectedValue(p2002(['workspace_id', 'name']));
    await expect(competencyRepository.createCategory(1, { name: 'Accounting' }))
      .rejects.toThrow('Category "Accounting" already exists in this workspace');
  });

  test('duplicate subcategory create names the parent', async () => {
    // validateParent + conflict-message lookups both resolve the parent row.
    prismaMock.competencyCategory.findUnique.mockResolvedValue({ id: 7, workspaceId: 1, parentId: null, name: 'Project Setup' });
    prismaMock.competencyCategory.create.mockRejectedValue(p2002(['workspace_id', 'parent_id', 'name']));

    await expect(competencyRepository.createCategory(1, { name: 'Quebec', parentId: 7 }))
      .rejects.toThrow('Subcategory "Quebec" already exists under "Project Setup"');
  });

  test('same sub name under a DIFFERENT parent is not blocked app-side', async () => {
    prismaMock.competencyCategory.findUnique.mockResolvedValue({ id: 8, workspaceId: 1, parentId: null, name: 'Accounting' });
    prismaMock.competencyCategory.create.mockResolvedValue({ id: 99, name: 'Quebec', parentId: 8 });

    await expect(competencyRepository.createCategory(1, { name: 'Quebec', parentId: 8 }))
      .resolves.toMatchObject({ id: 99 });
  });

  test('rename onto an existing sibling reports the friendly conflict', async () => {
    prismaMock.competencyCategory.findUnique
      .mockResolvedValueOnce({ id: 5, workspaceId: 1, parentId: 7, name: 'Ontario' }) // current row
      .mockResolvedValueOnce({ id: 7, workspaceId: 1, parentId: null, name: 'Project Setup' }); // parent for message
    prismaMock.competencyCategory.update.mockRejectedValue(p2002(['workspace_id', 'parent_id', 'name']));

    await expect(competencyRepository.updateCategory(5, { name: 'Quebec' }))
      .rejects.toThrow('Subcategory "Quebec" already exists under "Project Setup"');
  });
});

describe('rename side-effects on denormalized ticket fields', () => {
  test('top-level rename updates Ticket.tpSkill scoped by internalCategoryId', async () => {
    prismaMock.competencyCategory.findUnique.mockResolvedValue({ id: 3, workspaceId: 2, parentId: null, name: 'Old Name' });
    prismaMock.competencyCategory.update.mockResolvedValue({ id: 3, workspaceId: 2, parentId: null, name: 'New Name' });
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 12 });

    await competencyRepository.updateCategory(3, { name: 'New Name' });

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 2, internalCategoryId: 3 },
      data: { tpSkill: 'New Name' },
    });
  });

  test('subcategory rename updates Ticket.tpSubskill scoped by internalSubcategoryId', async () => {
    prismaMock.competencyCategory.findUnique.mockResolvedValue({ id: 9, workspaceId: 2, parentId: 3, name: 'Old Sub' });
    prismaMock.competencyCategory.update.mockResolvedValue({ id: 9, workspaceId: 2, parentId: 3, name: 'New Sub' });
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 4 });

    await competencyRepository.updateCategory(9, { name: 'New Sub' });

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 2, internalSubcategoryId: 9 },
      data: { tpSubskill: 'New Sub' },
    });
  });

  test('no ticket writes when the name did not change', async () => {
    prismaMock.competencyCategory.findUnique.mockResolvedValue({ id: 3, workspaceId: 2, parentId: null, name: 'Same' });
    prismaMock.competencyCategory.update.mockResolvedValue({ id: 3, workspaceId: 2, parentId: null, name: 'Same' });

    await competencyRepository.updateCategory(3, { name: 'Same', description: 'changed' });

    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });
});

describe('mergeCategories hardening', () => {
  const rows = [
    { id: 10, name: 'Project Setup', parentId: null },
    { id: 11, name: 'Accounting', parentId: null },
    { id: 20, name: 'Quebec', parentId: 10 },
    { id: 21, name: 'Quebec (QC)', parentId: 10 },
    { id: 22, name: 'Quebec', parentId: 11 },
  ];
  const rowsFor = (ids) => rows.filter((row) => ids.includes(row.id));

  function mockCategoryFindMany({ keepChildren = [], mergeChildren = [], remaining = [] } = {}) {
    prismaMock.competencyCategory.findMany.mockImplementation(async ({ where }) => {
      if (where?.id?.in) return rowsFor(where.id.in);
      if (typeof where?.parentId === 'number') return keepChildren;
      if (where?.parentId?.in) return mergeChildren;
      return remaining;
    });
  }

  test('rejects merging a top-level category into a subcategory (level guard)', async () => {
    mockCategoryFindMany();
    await expect(competencyRepository.mergeCategories(1, 20, [11]))
      .rejects.toThrow(/not at the same level/);
  });

  test('rejects cross-parent sub merges unless allowCrossParent is explicit', async () => {
    mockCategoryFindMany();
    await expect(competencyRepository.mergeCategories(1, 20, [22]))
      .rejects.toThrow(/different parent/);
  });

  test('sub merge remaps ticket internalSubcategoryId + parent + tpSubskill inside the transaction', async () => {
    mockCategoryFindMany();
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
    prismaMock.technicianCompetency.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 8 });
    prismaMock.categoryGroupLink.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.deleteMany.mockResolvedValue({ count: 1 });

    const result = await competencyRepository.mergeCategories(1, 20, [21]);

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, internalSubcategoryId: { in: [21] } },
      data: { internalSubcategoryId: 20, internalCategoryId: 10, tpSubskill: 'Quebec' },
    });
    expect(result.merged).toBe(1);
  });

  test('top-level merge remaps internalCategoryId, tpSkill, and re-parents children', async () => {
    mockCategoryFindMany({ keepChildren: [{ name: 'Quebec' }], mergeChildren: [{ name: 'Ontario' }] });
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
    prismaMock.technicianCompetency.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.competencyCategory.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.categoryGroupLink.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.deleteMany.mockResolvedValue({ count: 1 });

    await competencyRepository.mergeCategories(1, 10, [11]);

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, internalCategoryId: { in: [11] } },
      data: { internalCategoryId: 10, tpSkill: 'Project Setup' },
    });
    expect(prismaMock.competencyCategory.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 1, parentId: { in: [11] } },
      data: { parentId: 10 },
    });
  });

  test('top-level merge pre-checks child-name collisions against the per-parent index', async () => {
    mockCategoryFindMany({ keepChildren: [{ name: 'Quebec' }], mergeChildren: [{ name: 'quebec' }] });

    await expect(competencyRepository.mergeCategories(1, 10, [11]))
      .rejects.toThrow(/exists under both/);
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  test('category→group links are remapped dedupe-aware', async () => {
    mockCategoryFindMany();
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
    prismaMock.technicianCompetency.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.categoryGroupLink.findMany
      .mockResolvedValueOnce([{ groupId: 100n }]) // keep's links
      .mockResolvedValueOnce([
        { id: 7, groupId: 100n }, // duplicate → delete
        { id: 8, groupId: 200n }, // unique → remap
      ]);
    prismaMock.categoryGroupLink.delete.mockResolvedValue({});
    prismaMock.categoryGroupLink.update.mockResolvedValue({});
    prismaMock.competencyCategory.deleteMany.mockResolvedValue({ count: 1 });

    await competencyRepository.mergeCategories(1, 20, [21]);

    expect(prismaMock.categoryGroupLink.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(prismaMock.categoryGroupLink.update).toHaveBeenCalledWith({ where: { id: 8 }, data: { categoryId: 20 } });
  });
});

describe('getCategoriesDetailed (frozen contract for CompetencyManager)', () => {
  test('returns all rows with parentName and grouped counts', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 1, name: 'Project Setup', description: null, parentId: null, isActive: true, source: 'manual', sortOrder: 0, isSystemSuggested: false, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') },
      { id: 2, name: 'Quebec', description: 'QC projects', parentId: 1, isActive: true, source: 'manual', sortOrder: 1, isSystemSuggested: false, createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-02-02') },
      { id: 3, name: 'Retired', description: null, parentId: null, isActive: false, source: 'skill_hierarchy_retired', sortOrder: 2, isSystemSuggested: false, createdAt: new Date('2026-01-03'), updatedAt: new Date('2026-02-03') },
    ]);
    prismaMock.technicianCompetency.groupBy.mockResolvedValue([
      { competencyCategoryId: 1, _count: { _all: 5 } },
      { competencyCategoryId: 2, _count: { _all: 2 } },
    ]);
    prismaMock.ticket.groupBy.mockImplementation(async ({ by }) => {
      if (by[0] === 'internalCategoryId') return [{ internalCategoryId: 1, _count: { _all: 40 } }];
      return [{ internalSubcategoryId: 2, _count: { _all: 15 } }];
    });
    prismaMock.competencyCategory.groupBy.mockResolvedValue([
      { parentId: 1, _count: { _all: 1 } },
    ]);

    const detailed = await competencyRepository.getCategoriesDetailed(1);

    expect(detailed).toHaveLength(3);
    expect(detailed[0]).toMatchObject({
      id: 1, name: 'Project Setup', parentId: null, parentName: null,
      isActive: true, source: 'manual', sortOrder: 0, isSystemSuggested: false,
      ticketCount: 40, techCount: 5, childCount: 1,
    });
    expect(detailed[1]).toMatchObject({
      id: 2, name: 'Quebec', parentId: 1, parentName: 'Project Setup',
      description: 'QC projects', ticketCount: 15, techCount: 2, childCount: 0,
    });
    expect(detailed[2]).toMatchObject({
      id: 3, name: 'Retired', isActive: false, ticketCount: 0, techCount: 0, childCount: 0,
    });
    // Contract keys exactly (frontend relies on this shape).
    expect(Object.keys(detailed[0]).sort()).toEqual([
      'childCount', 'createdAt', 'description', 'id', 'isActive', 'isSystemSuggested',
      'name', 'parentId', 'parentName', 'sortOrder', 'source', 'techCount', 'ticketCount', 'updatedAt',
    ]);
  });
});
