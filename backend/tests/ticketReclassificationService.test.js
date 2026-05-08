import { jest } from '@jest/globals';

const mockMessagesCreate = jest.fn();

const prismaMock = {
  competencyCategory: {
    findMany: jest.fn(),
  },
  ticket: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  ticketReclassificationRun: {
    create: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(async (callback) => callback(prismaMock)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    anthropic: { apiKey: 'test-key' },
  },
}));

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: ticketReclassificationService } = await import('../src/services/ticketReclassificationService.js');

describe('ticketReclassificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.competencyCategory.findMany.mockReset();
    prismaMock.ticket.findMany.mockReset();
    prismaMock.ticket.update.mockReset();
    prismaMock.ticketReclassificationRun.create.mockReset();
    prismaMock.ticketReclassificationRun.update.mockReset();
    prismaMock.ticketReclassificationRun.findMany.mockReset();
    prismaMock.ticketReclassificationRun.findFirst.mockReset();
    prismaMock.$transaction.mockClear();
    prismaMock.ticketReclassificationRun.create.mockResolvedValue({ id: 900 });
    prismaMock.ticketReclassificationRun.update.mockResolvedValue({});
    mockMessagesCreate.mockReset();
  });

  test('blocks non-IT workspaces during phased migration', async () => {
    await expect(ticketReclassificationService.run(2, { apply: true })).rejects.toThrow(
      'enabled only for the IT category/subcategory migration workspace',
    );

    expect(prismaMock.competencyCategory.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('applies internal classification fields only for IT tickets', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 10, name: 'Account & Access', description: null, parentId: null, sortOrder: 1 },
      { id: 11, name: 'Password & MFA', description: null, parentId: 10, sortOrder: 1 },
    ]);
    prismaMock.ticket.findMany.mockResolvedValue([{
      id: 501,
      freshserviceTicketId: 221730n,
      subject: 'User cannot complete MFA sign-in',
      descriptionText: 'Requester needs MFA reset after phone change.',
      description: null,
      priority: 2,
      status: 2,
      category: 'Security',
      subCategory: null,
      ticketCategory: 'Account',
      tpSkill: null,
      tpSubskill: null,
      internalCategoryId: null,
      internalSubcategoryId: null,
      internalCategoryFit: null,
      internalSubcategoryFit: null,
      taxonomyReviewNeeded: false,
      createdAt: new Date('2026-05-01T12:00:00Z'),
      assignedTech: { id: 59, name: 'Vahid' },
    }]);
    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          internalCategoryId: 10,
          internalSubcategoryId: 11,
          categoryFit: 'exact',
          subcategoryFit: 'exact',
          confidence: 'high',
          classificationRationale: 'MFA reset request maps to Password & MFA.',
          suggestedInternalCategoryName: null,
          suggestedInternalSubcategoryName: null,
        }),
      }],
    });

    const result = await ticketReclassificationService.run(1, { apply: true, limit: 1, days: 30 });

    expect(result.dryRun).toBe(false);
    expect(result.id).toBe(900);
    expect(result.scanned).toBe(1);
    expect(result.classified).toBe(1);
    expect(prismaMock.ticketReclassificationRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: 1,
        status: 'running',
        mode: 'apply',
        beforeSnapshot: expect.arrayContaining([expect.objectContaining({ id: 501 })]),
      }),
    }));
    expect(prismaMock.ticketReclassificationRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 900 },
      data: expect.objectContaining({
        status: 'completed',
        summary: expect.objectContaining({ scanned: 1, classified: 1, failed: 0 }),
      }),
    }));
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: {
        internalCategoryId: 10,
        internalSubcategoryId: 11,
        internalCategoryConfidence: 'high',
        internalCategoryRationale: 'MFA reset request maps to Password & MFA.',
        internalCategoryFit: 'exact',
        internalSubcategoryFit: 'exact',
        taxonomyReviewNeeded: false,
        suggestedInternalCategoryName: null,
        suggestedInternalSubcategoryName: null,
      },
    });
  });

  test('dry run classifies without persisting', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 20, name: 'Hardware', description: null, parentId: null, sortOrder: 1 },
    ]);
    prismaMock.ticket.findMany.mockResolvedValue([{
      id: 600,
      freshserviceTicketId: 221999n,
      subject: 'Laptop issue',
      descriptionText: 'Keyboard is not working.',
      priority: 2,
      status: 2,
      category: null,
      subCategory: null,
      ticketCategory: null,
      tpSkill: null,
      tpSubskill: null,
      internalCategoryId: null,
      internalSubcategoryId: null,
      internalCategoryFit: null,
      internalSubcategoryFit: null,
      taxonomyReviewNeeded: false,
      createdAt: new Date('2026-05-02T12:00:00Z'),
      assignedTech: null,
    }]);
    mockMessagesCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          internalCategoryId: 20,
          internalSubcategoryId: null,
          categoryFit: 'weak',
          subcategoryFit: 'none',
          confidence: 'medium',
          classificationRationale: 'Closest existing parent is Hardware.',
          suggestedInternalCategoryName: null,
          suggestedInternalSubcategoryName: 'Keyboard',
        }),
      }],
    });

    const result = await ticketReclassificationService.run(1, { limit: 1 });

    expect(result.dryRun).toBe(true);
    expect(result.reviewNeeded).toBe(1);
    expect(prismaMock.ticketReclassificationRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ mode: 'dry_run' }),
    }));
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  test('rolls back an applied audit run from its before snapshot', async () => {
    prismaMock.ticketReclassificationRun.findFirst.mockResolvedValue({
      id: 900,
      mode: 'apply',
      status: 'completed',
      rolledBackAt: null,
      beforeSnapshot: [{
        id: 501,
        internalCategoryId: null,
        internalSubcategoryId: null,
        internalCategoryConfidence: null,
        internalCategoryRationale: null,
        internalCategoryFit: null,
        internalSubcategoryFit: null,
        taxonomyReviewNeeded: false,
        suggestedInternalCategoryName: null,
        suggestedInternalSubcategoryName: null,
      }],
    });

    const result = await ticketReclassificationService.rollback(1, 900, 'admin@example.com');

    expect(result.restoredCount).toBe(1);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: {
        internalCategoryId: null,
        internalSubcategoryId: null,
        internalCategoryConfidence: null,
        internalCategoryRationale: null,
        internalCategoryFit: null,
        internalSubcategoryFit: null,
        taxonomyReviewNeeded: false,
        suggestedInternalCategoryName: null,
        suggestedInternalSubcategoryName: null,
      },
    });
    expect(prismaMock.ticketReclassificationRun.update).toHaveBeenCalledWith({
      where: { id: 900 },
      data: expect.objectContaining({
        rolledBackBy: 'admin@example.com',
        rollbackResult: { restoredTicketIds: [501], restoredCount: 1 },
      }),
    });
  });
});
