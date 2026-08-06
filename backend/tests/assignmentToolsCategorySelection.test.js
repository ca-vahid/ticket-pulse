import { jest } from '@jest/globals';

/**
 * resolveInternalCategorySelection under per-parent name uniqueness: the
 * subcategory lookup is scoped by the resolved parent, and bare names that
 * are ambiguous across parents resolve to nothing rather than an arbitrary
 * sibling (the July 2026 misclassification class).
 */
const prismaMock = {
  competencyCategory: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolveInternalCategorySelection } = await import('../src/services/assignmentTools.js');

const CATEGORIES = [
  { id: 1, name: 'Project Setup', parentId: null },
  { id: 2, name: 'Accounting', parentId: null },
  { id: 3, name: 'Quebec', parentId: 1 },
  { id: 4, name: 'Quebec', parentId: 2 },
  { id: 5, name: 'Unique Sub', parentId: 1 },
];

beforeEach(() => {
  prismaMock.competencyCategory.findMany.mockReset();
  prismaMock.competencyCategory.findMany.mockResolvedValue(CATEGORIES);
});

describe('resolveInternalCategorySelection scoped lookups', () => {
  test('same sub name resolves under EACH parent independently', async () => {
    const first = await resolveInternalCategorySelection(1, { categoryName: 'Project Setup', subcategoryName: 'Quebec' });
    expect(first.category?.id).toBe(1);
    expect(first.subcategory?.id).toBe(3);

    const second = await resolveInternalCategorySelection(1, { categoryName: 'Accounting', subcategoryName: 'Quebec' });
    expect(second.category?.id).toBe(2);
    expect(second.subcategory?.id).toBe(4);
  });

  test('subcategory name without a resolved parent resolves nothing', async () => {
    const result = await resolveInternalCategorySelection(1, { subcategoryName: 'Quebec' });
    expect(result.category).toBeNull();
    expect(result.subcategory).toBeNull();
  });

  test('a categoryName that is an ambiguous sub name resolves nothing', async () => {
    const result = await resolveInternalCategorySelection(1, { categoryName: 'Quebec' });
    expect(result.category).toBeNull();
    expect(result.subcategory).toBeNull();
  });

  test('a categoryName that is an unambiguous sub name resolves the sub and its parent', async () => {
    const result = await resolveInternalCategorySelection(1, { categoryName: 'Unique Sub' });
    expect(result.category?.id).toBe(1);
    expect(result.subcategory?.id).toBe(5);
  });

  test('subcategory id still wins and infers its parent', async () => {
    const result = await resolveInternalCategorySelection(1, { categoryId: 4 });
    expect(result.category?.id).toBe(2);
    expect(result.subcategory?.id).toBe(4);
  });

  test('subcategory name under the WRONG parent does not match', async () => {
    const result = await resolveInternalCategorySelection(1, { categoryName: 'Accounting', subcategoryName: 'Unique Sub' });
    expect(result.category?.id).toBe(2);
    expect(result.subcategory).toBeNull();
  });
});
