import { jest } from '@jest/globals';

const mockGetCategories = jest.fn();
const mockCreateCategory = jest.fn();
const mockUpdateCategory = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    competencyCategory: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
}));

jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/competencyRepository.js', () => ({
  default: {
    getCategories: mockGetCategories,
    createCategory: mockCreateCategory,
    updateCategory: mockUpdateCategory,
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    anthropic: { apiKey: null },
  },
}));

const { default: assignmentDailyReviewConsolidationService } =
  await import('../src/services/assignmentDailyReviewConsolidationService.js');

describe('assignmentDailyReviewConsolidationService category guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCategories.mockResolvedValue([
      { id: 10, name: 'Devices & Hardware', parentId: null, description: null, isActive: true },
    ]);
    mockCreateCategory.mockResolvedValue({ id: 22 });
    mockUpdateCategory.mockResolvedValue({ id: 10 });
  });

  test('blocks top-level category creation for the IT skill hierarchy workspace', async () => {
    await expect(assignmentDailyReviewConsolidationService._applySkillItem(1, {
      actionType: 'add',
      payload: {
        action: 'add',
        categoryName: 'Wearable Devices',
      },
    })).rejects.toThrow('IT category consolidation can add subcategories only');

    expect(mockCreateCategory).not.toHaveBeenCalled();
  });

  test('allows subcategory creation under an existing parent for the IT skill hierarchy workspace', async () => {
    const result = await assignmentDailyReviewConsolidationService._applySkillItem(1, {
      actionType: 'add',
      payload: {
        action: 'add',
        categoryName: 'Wearable Devices',
        parentCategoryId: 10,
      },
    });

    expect(result).toEqual({ action: 'created_skill', categoryId: 22 });
    expect(mockCreateCategory).toHaveBeenCalledWith(1, expect.objectContaining({
      name: 'Wearable Devices',
      parentId: 10,
      source: 'daily_review_consolidation',
    }));
  });

  test('blocks technician competency changes that would create a missing IT category', async () => {
    await expect(assignmentDailyReviewConsolidationService._applyTechnicianCompetencyItem(1, {
      actionType: 'upsert_competency',
      payload: {
        technicianId: 56,
        technicianName: 'Test Tech',
        categoryName: 'Wearable Devices',
        proficiencyLevel: 'intermediate',
      },
    })).rejects.toThrow('IT technician competency changes must use an existing category/subcategory');

    expect(mockCreateCategory).not.toHaveBeenCalled();
  });
});
