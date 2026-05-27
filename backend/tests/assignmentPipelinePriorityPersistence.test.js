import { jest } from '@jest/globals';

const prismaMock = {
  ticket: {
    update: jest.fn(),
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
  default: {},
}));

jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../src/services/availabilityService.js', () => ({
  default: {},
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

describe('assignmentPipelineService priority persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.ticket.update.mockResolvedValue({});
  });

  test('persists assessed priority fields from the structured recommendation', async () => {
    await assignmentPipelineService._persistPriorityAssessment(501, 3101, {
      assessedPriority: 'High',
      priorityRationale: 'Requester cannot access production VPN during an active project window.',
      priorityConfidence: 'high',
      prioritySignals: ['blocked access', 'active project'],
    });

    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: expect.objectContaining({
        assessedPriority: 'High',
        assessedPriorityId: 3,
        priorityRationale: 'Requester cannot access production VPN during an active project window.',
        priorityConfidence: 'high',
        priorityEvidence: ['blocked access', 'active project'],
        priorityAssessedByRunId: 3101,
        priorityAssessedAt: expect.any(Date),
      }),
    });
  });
});
