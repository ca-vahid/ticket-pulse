import { jest } from '@jest/globals';

const prismaMock = {
  ticket: {
    update: jest.fn(),
  },
  // Per-workspace type registry backing the workspace-aware normalizer.
  ticketTypeDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident', 'issue'], isActive: true, aiAssignable: true, fsTypeValue: 'Incident', sortOrder: 0 },
      { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['sr'], isActive: true, aiAssignable: true, fsTypeValue: 'Service Request', sortOrder: 1 },
    ]),
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
  applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
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

const {
  default: assignmentPipelineService,
  priorityWritebackSkipReasonForTrigger,
} = await import('../src/services/assignmentPipelineService.js');

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

  test('persists assessed ticket type fields from the structured recommendation', async () => {
    await assignmentPipelineService._persistTicketTypeAssessment(501, 3102, {
      ticketType: 'incident',
      ticketTypeRationale: 'A previously working VPN is now unavailable.',
      ticketTypeConfidence: 'high',
    }, 1);

    expect(prismaMock.ticket.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: expect.objectContaining({
        assessedTicketType: 'Incident',
        ticketTypeRationale: 'A previously working VPN is now unavailable.',
        ticketTypeConfidence: 'high',
        ticketTypeAssessedByRunId: 3102,
        ticketTypeAssessedAt: expect.any(Date),
      }),
    });
  });

  test('skips FreshService priority writeback for external priority-change reassessments', () => {
    expect(priorityWritebackSkipReasonForTrigger('priority_changed'))
      .toBe('external_priority_change_reassessment_no_writeback');
    expect(priorityWritebackSkipReasonForTrigger('poll')).toBeNull();
    expect(priorityWritebackSkipReasonForTrigger('priority_assessment_only')).toBeNull();
    expect(priorityWritebackSkipReasonForTrigger('priority_assessment_after_hours')).toBeNull();
    expect(priorityWritebackSkipReasonForTrigger('poll', { priorityWritebackEnabled: false }))
      .toBe('priority_writeback_disabled');
  });
});
