import { jest } from '@jest/globals';

const mockBulkUpdateTechnicianCompetencies = jest.fn();

const prismaMock = {
  competencyCategory: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  technicianCompetency: {
    findMany: jest.fn(),
  },
  ticket: {
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/competencyRepository.js', () => ({
  default: {
    bulkUpdateTechnicianCompetencies: mockBulkUpdateTechnicianCompetencies,
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
    anthropic: { apiKey: 'test-key' },
  },
}));

const { default: competencyAnalysisService } = await import('../src/services/competencyAnalysisService.js');

describe('competencyAnalysisService apply guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.competencyCategory.findMany.mockReset();
    prismaMock.technicianCompetency.findMany.mockReset();
    prismaMock.ticket.findMany.mockReset();
    prismaMock.competencyCategory.create.mockResolvedValue({});
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
  });

  test('does not apply a valid category id when only legacy evidence exists', async () => {
    const categories = [{ id: 10, name: 'Security', parentId: null, isActive: true }];
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce(categories)
      .mockResolvedValueOnce(categories);

    const result = await competencyAnalysisService._applyAssessment(56, 1, {
      competencies: [{
        categoryAction: 'reuse_existing',
        categoryId: 10,
        categoryName: 'Security',
        proficiencyLevel: 'expert',
        confidence: 'high',
        evidenceSummary: 'Many legacy Freshservice security tickets.',
      }],
    });

    expect(result.preservedExisting).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.skippedNoCanonicalEvidence).toBe(1);
    expect(mockBulkUpdateTechnicianCompetencies).not.toHaveBeenCalled();
  });

  test('applies only mappings backed by clean canonical Ticket Pulse evidence', async () => {
    const categories = [
      { id: 10, name: 'Collaboration & Files', parentId: null, isActive: true },
      { id: 11, name: 'OneDrive / SharePoint Sync', parentId: 10, isActive: true },
      { id: 12, name: 'Legacy Security', parentId: null, isActive: true },
    ];
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        internalCategoryId: 10,
        internalSubcategoryId: 11,
        internalCategoryFit: 'exact',
        internalSubcategoryFit: 'exact',
        taxonomyReviewNeeded: false,
      },
      {
        internalCategoryId: 10,
        internalSubcategoryId: 11,
        internalCategoryFit: 'exact',
        internalSubcategoryFit: 'exact',
        taxonomyReviewNeeded: false,
      },
      {
        internalCategoryId: 12,
        internalSubcategoryId: null,
        internalCategoryFit: 'weak',
        internalSubcategoryFit: null,
        taxonomyReviewNeeded: true,
      },
    ]);
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce(categories)
      .mockResolvedValueOnce(categories);

    const result = await competencyAnalysisService._applyAssessment(56, 1, {
      competencies: [
        {
          categoryAction: 'reuse_existing',
          categoryId: 11,
          categoryName: 'OneDrive / SharePoint Sync',
          proficiencyLevel: 'basic',
          confidence: 'medium',
          evidenceSummary: 'Clean canonical OneDrive sync evidence.',
        },
        {
          categoryAction: 'reuse_existing',
          categoryId: 11,
          categoryName: 'OneDrive / SharePoint Sync',
          proficiencyLevel: 'advanced',
          confidence: 'high',
          evidenceSummary: 'Duplicate entry should keep highest proficiency.',
        },
        {
          categoryAction: 'reuse_existing',
          categoryId: 12,
          categoryName: 'Legacy Security',
          proficiencyLevel: 'expert',
          confidence: 'high',
          evidenceSummary: 'Only caution/legacy evidence exists.',
        },
      ],
    });

    expect(result.preservedExisting).toBe(false);
    expect(result.applied).toBe(1);
    expect(result.skippedNoCanonicalEvidence).toBe(1);
    expect(result.cappedByCleanEvidence).toBe(1);
    expect(mockBulkUpdateTechnicianCompetencies).toHaveBeenCalledWith(56, 1, [{
      competencyCategoryId: 11,
      proficiencyLevel: 'intermediate',
      notes: 'Duplicate entry should keep highest proficiency.',
    }]);
  });

  test('preserves an existing level when clean evidence is too sparse for an upgrade', async () => {
    const categories = [
      { id: 10, name: 'Onboarding & Offboarding', parentId: null, isActive: true },
      { id: 11, name: 'Account Decommissioning', parentId: 10, isActive: true },
    ];
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        internalCategoryId: 10,
        internalSubcategoryId: 11,
        internalCategoryFit: 'exact',
        internalSubcategoryFit: 'exact',
        taxonomyReviewNeeded: false,
      },
    ]);
    prismaMock.technicianCompetency.findMany.mockResolvedValue([
      { competencyCategoryId: 11, proficiencyLevel: 'intermediate', notes: 'Existing reviewed mapping' },
    ]);
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce(categories)
      .mockResolvedValueOnce(categories);

    const result = await competencyAnalysisService._applyAssessment(56, 1, {
      competencies: [{
        categoryAction: 'reuse_existing',
        categoryId: 11,
        categoryName: 'Account Decommissioning',
        proficiencyLevel: 'advanced',
        confidence: 'high',
        evidenceSummary: 'One clean canonical ticket plus legacy context.',
      }],
    });

    expect(result.preservedExisting).toBe(true);
    expect(result.cappedByCleanEvidence).toBe(1);
    expect(mockBulkUpdateTechnicianCompetencies).not.toHaveBeenCalled();
  });

  test('does not add a parent competency when supported subskill mappings already exist', async () => {
    const categories = [
      { id: 10, name: 'Onboarding & Offboarding', parentId: null, isActive: true },
      { id: 11, name: 'Offboarding', parentId: 10, isActive: true },
    ];
    prismaMock.ticket.findMany.mockResolvedValue([
      { internalCategoryId: 10, internalSubcategoryId: 11, internalCategoryFit: 'exact', internalSubcategoryFit: 'exact', taxonomyReviewNeeded: false },
      { internalCategoryId: 10, internalSubcategoryId: 11, internalCategoryFit: 'exact', internalSubcategoryFit: 'exact', taxonomyReviewNeeded: false },
      { internalCategoryId: 10, internalSubcategoryId: 11, internalCategoryFit: 'exact', internalSubcategoryFit: 'exact', taxonomyReviewNeeded: false },
    ]);
    prismaMock.technicianCompetency.findMany.mockResolvedValue([
      { competencyCategoryId: 11, proficiencyLevel: 'advanced', notes: 'Existing child mapping' },
    ]);
    prismaMock.competencyCategory.findMany
      .mockResolvedValueOnce(categories)
      .mockResolvedValueOnce(categories);

    const result = await competencyAnalysisService._applyAssessment(56, 1, {
      competencies: [
        {
          categoryAction: 'reuse_existing',
          categoryId: 10,
          categoryName: 'Onboarding & Offboarding',
          proficiencyLevel: 'advanced',
          evidenceSummary: 'Parent-level summary from child evidence.',
        },
        {
          categoryAction: 'reuse_existing',
          categoryId: 11,
          categoryName: 'Offboarding',
          proficiencyLevel: 'advanced',
          evidenceSummary: 'Existing child remains valid.',
        },
      ],
    });

    expect(result.skippedParentCoveredBySubskills).toBe(1);
    expect(result.preservedExisting).toBe(false);
    expect(mockBulkUpdateTechnicianCompetencies).toHaveBeenCalledWith(56, 1, [{
      competencyCategoryId: 11,
      proficiencyLevel: 'advanced',
      notes: 'Existing child remains valid.',
    }]);
  });

  test('keeps legacy category matching behavior outside the skill hierarchy workspace', async () => {
    const categories = [{ id: 20, name: 'Security', parentId: null, isActive: true }];
    prismaMock.competencyCategory.findMany.mockResolvedValue(categories);

    const result = await competencyAnalysisService._applyAssessment(77, 2, {
      competencies: [{
        categoryAction: 'reuse_existing',
        categoryName: 'Security',
        proficiencyLevel: 'intermediate',
        confidence: 'medium',
        evidenceSummary: 'Legacy category evidence from this workspace.',
      }],
    });

    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
    expect(result.legacyCategoryMode).toBe(true);
    expect(result.applied).toBe(1);
    expect(mockBulkUpdateTechnicianCompetencies).toHaveBeenCalledWith(77, 2, [{
      competencyCategoryId: 20,
      proficiencyLevel: 'intermediate',
      notes: 'Legacy category evidence from this workspace.',
    }]);
  });
});
