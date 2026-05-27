import { jest } from '@jest/globals';

const assignmentRepositoryMock = {
  getOpenPipelineRun: jest.fn(),
  getConfig: jest.fn(),
  createQueuedRun: jest.fn(),
  createPipelineStep: jest.fn(),
};

const availabilityServiceMock = {
  isBusinessHours: jest.fn(),
};
const queueUrgentEscalationMock = jest.fn();

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
  default: {},
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
}));

jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/afterHoursUrgentEscalationService.js', () => ({
  default: {
    queueForPriorityRun: queueUrgentEscalationMock,
  },
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { default: assignmentPipelineService } = await import('../src/services/assignmentPipelineService.js');

describe('assignmentPipelineService after-hours priority workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assignmentRepositoryMock.getOpenPipelineRun.mockResolvedValue(null);
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      priorityAssessmentAfterHoursEnabled: true,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    assignmentRepositoryMock.createQueuedRun.mockResolvedValue({
      id: 8801,
      status: 'queued',
      triggerSource: 'poll',
    });
    assignmentRepositoryMock.createPipelineStep.mockResolvedValue({ id: 9901 });
    prismaMock.assignmentPipelineStep.aggregate.mockResolvedValue({ _max: { stepNumber: 7 } });
    prismaMock.ticket.findUnique.mockResolvedValue({ status: 'Open', assignedTechId: null });
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Vancouver' });
    availabilityServiceMock.isBusinessHours.mockResolvedValue({
      isBusinessHours: false,
      reason: 'Outside business hours (09:00 - 17:00)',
    });
    queueUrgentEscalationMock.mockResolvedValue({ queued: 1, channels: ['sms'] });
  });

  test('uses the priority-first workflow for automatic after-hours runs when enabled', async () => {
    const workflowSpy = jest
      .spyOn(assignmentPipelineService, '_runAfterHoursPriorityAssessmentAndQueue')
      .mockResolvedValue({ id: 8801, status: 'queued' });

    const result = await assignmentPipelineService.runPipeline(501, 5, 'poll');

    expect(result).toEqual({ id: 8801, status: 'queued' });
    expect(workflowSpy).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours (09:00 - 17:00)',
      reboundFrom: null,
    }));
    expect(assignmentRepositoryMock.createQueuedRun).not.toHaveBeenCalled();

    workflowSpy.mockRestore();
  });

  test('keeps queue-only behavior when after-hours priority assessment is disabled', async () => {
    assignmentRepositoryMock.getConfig.mockResolvedValue({
      isEnabled: true,
      priorityAssessmentAfterHoursEnabled: false,
      llmModel: 'claude-sonnet-4-6-20260217',
    });
    const events = [];

    const result = await assignmentPipelineService.runPipeline(
      501,
      5,
      'poll',
      (event) => events.push(event),
    );

    expect(result).toEqual(expect.objectContaining({ id: 8801, status: 'queued' }));
    expect(assignmentRepositoryMock.createQueuedRun).toHaveBeenCalledWith({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours (09:00 - 17:00)',
      reboundFrom: null,
    });
    expect(events).toEqual(expect.arrayContaining([
      { type: 'queued', runId: 8801, reason: 'Outside business hours (09:00 - 17:00)' },
      { type: 'complete' },
    ]));
  });

  test('priority helper executes priority-only first and queues the original assignment trigger', async () => {
    const runPipelineSpy = jest.spyOn(assignmentPipelineService, 'runPipeline').mockResolvedValue({
      id: 7701,
      status: 'completed',
      decision: 'priority_only',
      recommendation: { assessedPriority: 'Urgent' },
    });
    const events = [];

    const result = await assignmentPipelineService._runAfterHoursPriorityAssessmentAndQueue({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours (09:00 - 17:00)',
      reboundFrom: null,
      emit: (event) => events.push(event),
      signal: null,
    });

    expect(runPipelineSpy).toHaveBeenCalledWith(
      501,
      5,
      'priority_assessment_after_hours',
      null,
      null,
      { parentTriggerSource: 'poll' },
    );
    expect(assignmentRepositoryMock.createQueuedRun).toHaveBeenCalledWith({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours (09:00 - 17:00)',
      reboundFrom: null,
    });
    expect(result).toEqual(expect.objectContaining({
      id: 8801,
      afterHoursPriorityRunId: 7701,
      afterHoursPriorityStatus: 'completed',
      afterHoursAssessedPriority: 'Urgent',
      afterHoursUrgentEscalation: { queued: 1, channels: ['sms'] },
    }));
    expect(queueUrgentEscalationMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 7701,
      decision: 'priority_only',
    }));
    expect(assignmentRepositoryMock.createPipelineStep).toHaveBeenCalledWith(expect.objectContaining({
      pipelineRunId: 7701,
      stepNumber: 8,
      stepName: 'after_hours_urgent_escalation',
      status: 'completed',
      output: { queued: 1, channels: ['sms'] },
    }));
    expect(events[0]).toEqual({ type: 'priority_assessment_started', reason: 'after_hours_priority_only' });

    runPipelineSpy.mockRestore();
  });

  test('does not queue business-hours assignment when the after-hours priority pass dismisses noise', async () => {
    const runPipelineSpy = jest.spyOn(assignmentPipelineService, 'runPipeline').mockResolvedValue({
      id: 7702,
      status: 'completed',
      decision: 'noise_dismissed',
      recommendation: {
        assessedPriority: 'Low',
        recommendations: [],
        closureNoticeHtml: 'This ticket does not require helpdesk follow-up.',
      },
    });

    const result = await assignmentPipelineService._runAfterHoursPriorityAssessmentAndQueue({
      ticketId: 501,
      workspaceId: 5,
      triggerSource: 'poll',
      queuedReason: 'Outside business hours (09:00 - 17:00)',
      reboundFrom: null,
      emit: jest.fn(),
      signal: null,
    });

    expect(result).toEqual(expect.objectContaining({
      id: 7702,
      decision: 'noise_dismissed',
      afterHoursAssignmentQueued: false,
      afterHoursQueueSkippedReason: 'noise_dismissed',
    }));
    expect(assignmentRepositoryMock.createQueuedRun).not.toHaveBeenCalled();
    expect(queueUrgentEscalationMock).not.toHaveBeenCalled();

    runPipelineSpy.mockRestore();
  });
});
