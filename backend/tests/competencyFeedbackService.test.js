import { jest } from '@jest/globals';

const prismaMock = {
  assignmentConfig: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), update: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  technicianCompetency: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));

const { default: competencyFeedbackService } = await import('../src/services/competencyFeedbackService.js');

// Regression guard for the Coreshack incident (Aug 14 2026): a single in-app
// reassignment auto-created a competency for a non-team member, silently
// adding him to the matching pool. The learner now has a per-workspace
// kill switch (assignment_configs.competency_feedback_enabled).
describe('competencyFeedbackService learning gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue({
      feedbackApplied: false,
      recommendation: {},
      ticket: {
        internalCategoryId: 92,
        internalSubcategoryId: null,
        internalCategory: { id: 92, name: 'SharePoint / Coreshack' },
        internalSubcategory: null,
        ticketCategory: null,
        category: null,
      },
    });
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 92, name: 'SharePoint / Coreshack', parentId: null },
    ]);
    prismaMock.technicianCompetency.findUnique.mockResolvedValue(null);
    prismaMock.technicianCompetency.create.mockResolvedValue({ id: 1 });
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.technicianCompetency.count.mockResolvedValue(0);
  });

  test('learning disabled: no competency is created or promoted', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ competencyFeedbackEnabled: false });

    await competencyFeedbackService.processDecisionFeedback(101, 'modified', 48, 1);

    expect(prismaMock.technicianCompetency.create).not.toHaveBeenCalled();
    expect(prismaMock.technicianCompetency.update).not.toHaveBeenCalled();
    // The run must not be consumed either — a later re-enable can still apply it.
    expect(prismaMock.assignmentPipelineRun.update).not.toHaveBeenCalled();
  });

  test('learning enabled (default): auto-creates a basic competency', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ competencyFeedbackEnabled: true });

    await competencyFeedbackService.processDecisionFeedback(101, 'modified', 48, 1);

    expect(prismaMock.technicianCompetency.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        technicianId: 48,
        competencyCategoryId: 92,
        proficiencyLevel: 'basic',
        notes: 'Auto-created from assignment feedback',
      }),
    }));
  });

  test('missing config row behaves as enabled (default-true semantics)', async () => {
    prismaMock.assignmentConfig.findUnique.mockResolvedValue(null);

    await competencyFeedbackService.processDecisionFeedback(101, 'approved', 48, 1);

    expect(prismaMock.technicianCompetency.create).toHaveBeenCalled();
  });

  test('non-assignment decisions are ignored regardless of the gate', async () => {
    await competencyFeedbackService.processDecisionFeedback(101, 'rejected', 48, 1);
    expect(prismaMock.assignmentConfig.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.technicianCompetency.create).not.toHaveBeenCalled();
  });
});

// Regression guard for the CIO incident (Sep 2026): the AI auto-assigned a
// local (no-FreshService-identity) person four times; every write-back was
// skipped so nothing applied anywhere — but the learner credited each failed
// decision and minted competencies for someone who never held a ticket.
// Auto-assign decisions must only teach the matrix when they actually applied.
describe('competencyFeedbackService outcome gate (auto_assigned)', () => {
  const baseRun = (syncStatus) => ({
    feedbackApplied: false,
    recommendation: {},
    syncStatus,
    ticket: {
      internalCategoryId: 92,
      internalSubcategoryId: null,
      internalCategory: { id: 92, name: 'SharePoint / Coreshack' },
      internalSubcategory: null,
      ticketCategory: null,
      category: null,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({ competencyFeedbackEnabled: true });
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 92, name: 'SharePoint / Coreshack', parentId: null },
    ]);
    prismaMock.technicianCompetency.findUnique.mockResolvedValue(null);
    prismaMock.technicianCompetency.create.mockResolvedValue({ id: 1 });
    prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
    prismaMock.technicianCompetency.count.mockResolvedValue(0);
  });

  test.each(['skipped', 'failed', 'dry_run', null])(
    'auto_assigned with syncStatus=%s does NOT learn and does NOT consume the run',
    async (syncStatus) => {
      prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(baseRun(syncStatus));

      await competencyFeedbackService.processDecisionFeedback(101, 'auto_assigned', 48, 1);

      expect(prismaMock.technicianCompetency.create).not.toHaveBeenCalled();
      expect(prismaMock.assignmentPipelineRun.update).not.toHaveBeenCalled();
    },
  );

  test('auto_assigned with syncStatus=synced learns normally', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(baseRun('synced'));

    await competencyFeedbackService.processDecisionFeedback(101, 'auto_assigned', 48, 1);

    expect(prismaMock.technicianCompetency.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ technicianId: 48, proficiencyLevel: 'basic' }),
    }));
  });

  test('human decisions (modified) stay exempt from the outcome gate', async () => {
    prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(baseRun('skipped'));

    await competencyFeedbackService.processDecisionFeedback(101, 'modified', 48, 1);

    expect(prismaMock.technicianCompetency.create).toHaveBeenCalled();
  });
});
