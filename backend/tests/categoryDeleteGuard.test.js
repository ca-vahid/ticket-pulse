import { jest } from '@jest/globals';

/**
 * Guards added after the July 2026 Accounting incident: a bare category delete
 * orphaned 24 subcategories (parent_id -> NULL), nulled internal_category_id
 * on 4.4k tickets, and cascade-deleted technician competencies. Deleting a
 * category that still has children or tickets must be blocked, and the
 * analytics normalizer must self-heal orphaned rows it encounters.
 */

const prismaMock = {
  competencyCategory: {
    count: jest.fn(),
    delete: jest.fn().mockResolvedValue({ id: 5 }),
  },
  ticket: {
    count: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: competencyRepository } = await import('../src/services/competencyRepository.js');
const { normalizeTicketCategory } = await import('../src/utils/ticketCategoryNormalizer.js');
const { ValidationError } = await import('../src/utils/errors.js');

beforeEach(() => {
  prismaMock.competencyCategory.count.mockReset();
  prismaMock.ticket.count.mockReset();
  prismaMock.competencyCategory.delete.mockClear();
});

describe('competencyRepository.deleteCategory guards', () => {
  test('blocks deleting a category that still has subcategories', async () => {
    prismaMock.competencyCategory.count.mockResolvedValue(4);
    prismaMock.ticket.count.mockResolvedValue(0);
    await expect(competencyRepository.deleteCategory(166)).rejects.toThrow(ValidationError);
    await expect(competencyRepository.deleteCategory(166)).rejects.toThrow(/4 subcategories/);
    expect(prismaMock.competencyCategory.delete).not.toHaveBeenCalled();
  });

  test('blocks deleting a category that tickets reference', async () => {
    prismaMock.competencyCategory.count.mockResolvedValue(0);
    prismaMock.ticket.count.mockResolvedValue(1497);
    await expect(competencyRepository.deleteCategory(194)).rejects.toThrow(/1497 tickets are categorized/);
    expect(prismaMock.competencyCategory.delete).not.toHaveBeenCalled();
  });

  test('deletes a category with no children and no tickets', async () => {
    prismaMock.competencyCategory.count.mockResolvedValue(0);
    prismaMock.ticket.count.mockResolvedValue(0);
    await expect(competencyRepository.deleteCategory(5)).resolves.toEqual({ id: 5 });
    expect(prismaMock.competencyCategory.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

describe('normalizeTicketCategory self-heal (canonical workspaces)', () => {
  // Workspace 1 (IT) is the skill-hierarchy workspace in the default flags.
  const WS = 1;

  test('derives the top category from the subcategory parent when internalCategoryId is null', () => {
    const normalized = normalizeTicketCategory({
      internalCategoryId: null,
      internalSubcategoryId: 194,
      internalSubcategory: { id: 194, name: 'Corporate Traveller (CAFS) Invoice', parentId: 166, parent: { name: 'Corporate Travel Invoices' } },
    }, WS);
    expect(normalized.categoryId).toBe(166);
    expect(normalized.categoryName).toBe('Corporate Travel Invoices');
    expect(normalized.subcategoryName).toBe('Corporate Traveller (CAFS) Invoice');
    expect(normalized.categorySource).toBe('canonical');
  });

  test('explicit internalCategoryId wins over the subcategory parent', () => {
    const normalized = normalizeTicketCategory({
      internalCategoryId: 172,
      internalCategory: { id: 172, name: 'Vendor Statements & Account Reconciliation' },
      internalSubcategoryId: 194,
      internalSubcategory: { id: 194, name: 'X', parentId: 166, parent: { name: 'Corporate Travel Invoices' } },
    }, WS);
    expect(normalized.categoryId).toBe(172);
    expect(normalized.categoryName).toBe('Vendor Statements & Account Reconciliation');
  });

  test('still falls back to tpSkill when nothing canonical resolves', () => {
    const normalized = normalizeTicketCategory({
      internalCategoryId: null,
      internalSubcategoryId: null,
      tpSkill: 'Corporate Travel Invoices',
    }, WS);
    expect(normalized.categorySource).toBe('legacyFallback');
    expect(normalized.categoryName).toBe('Corporate Travel Invoices');
  });
});
