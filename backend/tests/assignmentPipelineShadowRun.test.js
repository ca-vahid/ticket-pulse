import { jest } from '@jest/globals';

// AI cost plan §5.1: a shadow run goes through the live pipeline's prompt,
// tools and loop on a named model and must write NOTHING.
const prismaMock = {
  ticket: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn().mockResolvedValue({ origin: 'freshservice' }) },
  workspace: { findUnique: jest.fn().mockResolvedValue({ defaultTimezone: 'America/Vancouver' }) },
  assignmentPipelineRun: { findUnique: jest.fn().mockResolvedValue({ reboundFrom: null }) },
  ticketAssignmentEpisode: { findFirst: jest.fn().mockResolvedValue(null) },
  aiProviderAttempt: { create: jest.fn() },
};
const repoMock = {
  getConfig: jest.fn().mockResolvedValue({ llmModel: 'claude-sonnet-5', autoCloseNoise: true }),
  updatePipelineRun: jest.fn(),
  createPipelineStep: jest.fn(),
  updatePipelineStep: jest.fn(),
  touchPipelineRun: jest.fn(),
  getPipelineRun: jest.fn(),
};
const runToolTurnMock = jest.fn();
const executeToolMock = jest.fn().mockResolvedValue({ subject: 'VPN down' });
const fsActionMock = {
  execute: jest.fn(),
  executePriorityWriteback: jest.fn(),
  executeTicketTypeWriteback: jest.fn(),
  executeCategoryWriteback: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: jest.fn() }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { anthropic: { apiKey: 'test-key' } } }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: repoMock }));
jest.unstable_mockModule('../src/services/promptRepository.js', () => ({
  default: {
    getPublished: jest.fn().mockResolvedValue({
      id: 7, version: 3, systemPrompt: 'You route tickets.', toolConfig: { enableWebSearch: false },
    }),
  },
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentTools.js', () => ({
  TOOL_SCHEMAS: [{ name: 'get_ticket_details' }, { name: 'submit_recommendation' }],
  executeTool: executeToolMock,
  applyWorkspaceTicketTypes: jest.fn(async (tools) => ({ tools, autoType: null })),
}));
jest.unstable_mockModule('../src/services/assignmentRecommendationValidation.js', () => ({
  normalizeSubmitRecommendationPayload: jest.fn(async (input) => ({ ...input })),
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: { runToolTurn: runToolTurnMock },
}));
jest.unstable_mockModule('../src/services/freshServiceActionService.js', () => ({ default: fsActionMock }));
jest.unstable_mockModule('../src/services/competencyFeedbackService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({
  default: { evaluateNeverNoise: jest.fn().mockResolvedValue({ vetoed: false, ruleId: null, ruleName: null }) },
}));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: service } = await import('../src/services/assignmentPipelineService.js');

const turn = (content, usage) => ({
  message: { content, stop_reason: 'tool_use' },
  usage,
  provider: 'openai',
  model: 'gpt-6-sol',
  attemptNumber: 1,
  fallbackUsed: false,
  shadow: true,
});

describe('assignmentPipelineService.shadowRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runToolTurnMock.mockReset();
    runToolTurnMock
      .mockResolvedValueOnce(turn(
        [{ type: 'tool_use', id: 't1', name: 'get_ticket_details', input: { ticketId: 501 } }],
        { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, totalTokens: 1050 },
      ))
      .mockResolvedValueOnce(turn(
        [{ type: 'tool_use', id: 't2', name: 'submit_recommendation', input: { recommendations: [{ techId: 42, rank: 1 }], overallReasoning: 'VPN person' } }],
        { inputTokens: 1200, outputTokens: 80, cacheReadInputTokens: 900, totalTokens: 1280 },
      ));
  });

  test('returns the verdict and token counts, writes nothing', async () => {
    const result = await service.shadowRun(501, 1, { model: 'gpt-6-sol', liveRunId: 3101 });

    expect(result).toMatchObject({
      shadow: true,
      provider: 'openai',
      model: 'gpt-6-sol',
      isNoise: false,
      noiseVetoed: false,
      turns: 2,
      toolCalls: 2,
      inputTokens: 2200,
      outputTokens: 130,
      cacheReadInputTokens: 900,
    });
    expect(result.recommendation.recommendations[0].techId).toBe(42);

    // The model saw the live prompt and tools, on the shadow model, with no run link.
    const opts = runToolTurnMock.mock.calls[0][0];
    expect(opts.shadow).toEqual({ model: 'gpt-6-sol', provider: null });
    expect(opts.runLinks).toEqual({});
    expect(opts.systemPrompt).toContain('You route tickets.');
    expect(opts.tools.map((t) => t.name)).toEqual(['get_ticket_details', 'submit_recommendation']);
    expect(executeToolMock).toHaveBeenCalledWith('get_ticket_details', { ticketId: 501 }, { workspaceId: 1, ticketId: 501 });

    for (const fn of ['updatePipelineRun', 'createPipelineStep', 'updatePipelineStep', 'touchPipelineRun', 'getPipelineRun']) {
      expect(repoMock[fn]).not.toHaveBeenCalled();
    }
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    for (const fn of Object.values(fsActionMock)) expect(fn).not.toHaveBeenCalled();
  });

  test('an empty recommendation list reads as noise', async () => {
    runToolTurnMock.mockReset();
    runToolTurnMock.mockResolvedValueOnce(turn(
      [{ type: 'tool_use', id: 't1', name: 'submit_recommendation', input: { recommendations: [], overallReasoning: 'newsletter' } }],
      { inputTokens: 10 },
    ));
    const result = await service.shadowRun(501, 1, { model: 'claude-sonnet-5' });
    expect(result.isNoise).toBe(true);
    expect(repoMock.updatePipelineRun).not.toHaveBeenCalled();
  });

  test('a failed shadow throws and never marks the borrowed live run failed', async () => {
    runToolTurnMock.mockReset();
    runToolTurnMock.mockRejectedValueOnce(new Error('provider down'));
    await expect(service.shadowRun(501, 1, { model: 'gpt-6-sol', liveRunId: 3101 })).rejects.toThrow('provider down');
    expect(repoMock.updatePipelineRun).not.toHaveBeenCalled();
  });

  test('needs a model', async () => {
    await expect(service.shadowRun(501, 1, {})).rejects.toThrow('needs a model');
  });
});
