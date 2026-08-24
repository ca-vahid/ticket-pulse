import { jest } from '@jest/globals';

/**
 * Phase DB: per-workspace duplicate-burst toggle.
 *
 * The duplicate-burst guard (same requester + identical normalized subject
 * within 15 min ⇒ link + skip the AI run) is now gated on
 * AssignmentConfig.duplicateBurstEnabled:
 *  - false          → guard disabled: detectBurstDuplicate is never called and
 *                     the pipeline proceeds to a real run;
 *  - true / absent  → guard active (back-compat: null/missing keeps today's
 *                     behavior, the competencyFeedbackEnabled !== false rule).
 */

const assignmentRepositoryMock = {
  getOpenPipelineRun: jest.fn(),
  getConfig: jest.fn(),
  createQueuedRun: jest.fn(),
  createPipelineStep: jest.fn(),
  createPipelineRun: jest.fn(),
};

const promptRepositoryMock = {
  getPublished: jest.fn(),
};

const availabilityServiceMock = {
  isBusinessHours: jest.fn(),
};

const duplicateBurstServiceMock = {
  detectBurstDuplicate: jest.fn(),
  dismissAsDuplicate: jest.fn(),
};

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const prismaMock = {
  ticket: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  workspace: {
    findUnique: jest.fn(),
  },
  assignmentPipelineRun: {
    findUnique: jest.fn(),
  },
  assignmentPipelineStep: {
    aggregate: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(),
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    anthropic: { apiKey: 'test-key' },
  },
}));

jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({
  default: assignmentRepositoryMock,
}));

jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: promptRepositoryMock,
}));

jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: availabilityServiceMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [],
  executeTool: jest.fn(),
  applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));

jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({
  default: { queueForPriorityRun: jest.fn() },
}));

jest.unstable_mockModule('../src/services/duplicateBurstService.js', () => ({
  default: duplicateBurstServiceMock,
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: loggerMock,
}));

const { default: assignmentPipelineService } = await import('../src/services/assignmentPipelineService.js');

describe('assignmentPipelineService duplicate-burst toggle', () => {
  const ORIGINAL = { id: 92, freshserviceTicketId: 232562n, nativeNumber: null, origin: 'freshservice' };

  beforeEach(() => {
    jest.clearAllMocks();
    assignmentRepositoryMock.getOpenPipelineRun.mockResolvedValue(null);
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      priorityAssessmentAfterHoursEnabled: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    assignmentRepositoryMock.createQueuedRun.mockResolvedValue({
      id: 8801,
      status: 'queued',
      triggerSource: 'poll',
    });
    prismaMock.ticket.findUnique.mockResolvedValue({ status: 'Open', assignedTechId: null });
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
    // Outside business hours so the pipeline QUEUES instead of hitting the
    // LLM — reaching createQueuedRun proves the guard was passed and the run
    // proceeded for real, without needing the whole agentic loop mocked.
    availabilityServiceMock.isBusinessHours.mockResolvedValue({
      isBusinessHours: false,
      reason: 'Outside business hours (09:00 - 17:00)',
    });
    duplicateBurstServiceMock.detectBurstDuplicate.mockResolvedValue(ORIGINAL);
    duplicateBurstServiceMock.dismissAsDuplicate.mockResolvedValue({ id: 777 });
  });

  test('duplicateBurstEnabled:false — guard is never invoked and the pipeline proceeds to a real run', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      duplicateBurstEnabled: false,
      priorityAssessmentAfterHoursEnabled: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });

    const result = await assignmentPipelineService.runPipeline(501, 5, 'poll');

    expect(duplicateBurstServiceMock.detectBurstDuplicate).not.toHaveBeenCalled();
    expect(duplicateBurstServiceMock.dismissAsDuplicate).not.toHaveBeenCalled();
    // Proceeded past the guard to the business-hours gate → queued run.
    expect(assignmentRepositoryMock.createQueuedRun).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
    }));
    expect(result).toEqual(expect.objectContaining({ id: 8801, status: 'queued' }));
    expect(loggerMock.debug).toHaveBeenCalledWith(
      'Duplicate-burst guard skipped: disabled for this workspace',
      expect.objectContaining({ ticketId: 501, workspaceId: 5, triggerSource: 'poll' }),
    );
  });

  test('duplicateBurstEnabled:true — burst copies are still dismissed without an AI run', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      duplicateBurstEnabled: true,
      priorityAssessmentAfterHoursEnabled: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    const events = [];

    const result = await assignmentPipelineService.runPipeline(501, 5, 'poll', (e) => events.push(e));

    expect(duplicateBurstServiceMock.detectBurstDuplicate).toHaveBeenCalledWith(501, 5);
    expect(duplicateBurstServiceMock.dismissAsDuplicate).toHaveBeenCalledWith(501, 5, ORIGINAL, 'poll');
    expect(result).toEqual({
      skipped: true,
      reason: 'duplicate_burst',
      duplicateOfTicketId: 92,
      runId: 777,
    });
    expect(assignmentRepositoryMock.createQueuedRun).not.toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([{ type: 'complete', runId: 777 }]));
  });

  test('field absent (pre-migration config) — guard keeps running (back-compat default ON)', async () => {
    // beforeEach config has NO duplicateBurstEnabled key at all.
    const result = await assignmentPipelineService.runPipeline(501, 5, 'webhook');

    expect(duplicateBurstServiceMock.detectBurstDuplicate).toHaveBeenCalledWith(501, 5);
    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'duplicate_burst' }));
    expect(assignmentRepositoryMock.createQueuedRun).not.toHaveBeenCalled();
  });

  test('manual trigger bypasses the guard regardless of the toggle', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      duplicateBurstEnabled: true,
      priorityAssessmentAfterHoursEnabled: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    // Manual runs skip the business-hours queue and go straight to a running
    // run — stub the execution leg so the test stops at the observable boundary.
    const executeSpy = jest.spyOn(assignmentPipelineService, '_executeRun').mockResolvedValue({ id: 9001 });
    promptRepositoryMock.getPublished.mockResolvedValue({ id: 1 });
    assignmentRepositoryMock.createPipelineRun.mockResolvedValue({ id: 9001 });

    await assignmentPipelineService.runPipeline(501, 5, 'manual');

    expect(duplicateBurstServiceMock.detectBurstDuplicate).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalled();
    executeSpy.mockRestore();
  });
});
