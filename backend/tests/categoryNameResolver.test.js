import { jest } from '@jest/globals';

// FR 08-05 #1 (Phase 1a) — category/subcategory BY NAME on the create API.
// Names resolve case-insensitively against the workspace's ACTIVE taxonomy;
// a subcategory must be a child of the resolved category; misses throw a
// ValidationError that lists the allowed values (capped at 30 + "…and N more").

const prismaMock = {
  competencyCategory: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveCategoryNames, formatAllowedValues } = await import('../src/services/categoryNameResolver.js');
const { ValidationError } = await import('../src/utils/errors.js');

const WS2_TAXONOMY = [
  { id: 11, workspaceId: 2, name: 'Project Setup', parentId: null, isActive: true },
  { id: 12, workspaceId: 2, name: 'Proposal Setup', parentId: null, isActive: true },
  { id: 21, workspaceId: 2, name: 'Quebec', parentId: 11, isActive: true },
  { id: 22, workspaceId: 2, name: 'Chile', parentId: 11, isActive: true },
  { id: 23, workspaceId: 2, name: 'Other', parentId: 11, isActive: true },
];

describe('resolveCategoryNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.competencyCategory.findMany.mockResolvedValue(WS2_TAXONOMY);
  });

  test('matches case-insensitively and returns canonical names + ids', async () => {
    const r = await resolveCategoryNames(2, 'project setup', 'QUEBEC');
    expect(r).toEqual({
      categoryId: 11, subcategoryId: 21, categoryName: 'Project Setup', subcategoryName: 'Quebec',
    });
  });

  test('queries ACTIVE taxonomy only (inactive rows can never match)', async () => {
    await resolveCategoryNames(2, 'Project Setup', null);
    expect(prismaMock.competencyCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 2, isActive: true },
    }));
  });

  test('category without subcategory resolves to a null subcategoryId', async () => {
    const r = await resolveCategoryNames(2, 'Proposal Setup', undefined);
    expect(r.categoryId).toBe(12);
    expect(r.subcategoryId).toBeNull();
  });

  test('nothing provided → all nulls, no query', async () => {
    const r = await resolveCategoryNames(2, null, null);
    expect(r).toEqual({ categoryId: null, subcategoryId: null, categoryName: null, subcategoryName: null });
    expect(prismaMock.competencyCategory.findMany).not.toHaveBeenCalled();
  });

  test('unknown category → ValidationError listing the workspace values', async () => {
    await expect(resolveCategoryNames(2, 'Hardware', null))
      .rejects.toThrow(/Unknown category "Hardware".*Project Setup, Proposal Setup/);
    await expect(resolveCategoryNames(2, 'Hardware', null)).rejects.toBeInstanceOf(ValidationError);
  });

  test('wrong-parent subcategory → error listing the valid children', async () => {
    // Quebec is a child of Project Setup, not Proposal Setup.
    await expect(resolveCategoryNames(2, 'Proposal Setup', 'Quebec'))
      .rejects.toThrow(/Unknown subcategory "Quebec" under "Proposal Setup"/);
  });

  test('subcategory names never match at the top level (and vice versa)', async () => {
    await expect(resolveCategoryNames(2, 'Quebec', null)).rejects.toThrow(/Unknown category/);
    await expect(resolveCategoryNames(2, 'Project Setup', 'Proposal Setup')).rejects.toThrow(/Unknown subcategory/);
  });

  test('subcategory without a category is rejected', async () => {
    await expect(resolveCategoryNames(2, '', 'Quebec'))
      .rejects.toThrow(/subcategory name requires its parent category/i);
  });

  test('allowed-values list is capped at 30 names + a summary', () => {
    const names = Array.from({ length: 45 }, (_, i) => `Cat ${i + 1}`);
    const text = formatAllowedValues(names);
    expect(text).toContain('Cat 30');
    expect(text).not.toContain('Cat 31');
    expect(text).toContain('…and 15 more');
    expect(formatAllowedValues([])).toBe('(none configured)');
  });
});
