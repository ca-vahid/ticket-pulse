import { jest } from '@jest/globals';

const prismaMock = {
  aiProviderAttempt: {
    create: jest.fn(),
    update: jest.fn(),
  },
};
const resolveAttemptsMock = jest.fn();
const recordSuccessMock = jest.fn();
const recordFailureMock = jest.fn();
const anthropicToolResponseMock = jest.fn();
const openAiToolResponseMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/aiProviders/providerModelResolver.js', () => ({
  default: { resolveAttempts: resolveAttemptsMock },
}));

jest.unstable_mockModule('../src/services/aiProviders/providerHealthService.js', () => ({
  default: {
    recordSuccess: recordSuccessMock,
    recordFailure: recordFailureMock,
  },
}));

jest.unstable_mockModule('../src/services/aiProviders/anthropicProvider.js', () => ({
  default: {
    toolResponse: anthropicToolResponseMock,
    sendJson: jest.fn(),
    isConfigured: jest.fn(() => true),
  },
}));

jest.unstable_mockModule('../src/services/aiProviders/openAiProvider.js', () => ({
  default: {
    toolResponse: openAiToolResponseMock,
    sendJson: jest.fn(),
    isConfigured: jest.fn(() => true),
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const { ProviderGateway } = await import('../src/services/aiProviders/providerGateway.js');

function setAttempts(attempts) {
  resolveAttemptsMock.mockResolvedValue({
    setting: { autoFallbackEnabled: true },
    primary: { provider: attempts[0].provider, model: attempts[0].model },
    fallback: attempts[1] ? { provider: attempts[1].provider, model: attempts[1].model } : null,
    attempts,
  });
}

describe('ProviderGateway', () => {
  let gateway;

  beforeEach(() => {
    gateway = new ProviderGateway();
    jest.clearAllMocks();
    prismaMock.aiProviderAttempt.create.mockResolvedValue({ id: 10 });
    prismaMock.aiProviderAttempt.update.mockResolvedValue({});
    recordSuccessMock.mockResolvedValue({});
    recordFailureMock.mockResolvedValue({});
  });

  test('returns Anthropic primary success without calling fallback', async () => {
    setAttempts([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ]);
    anthropicToolResponseMock.mockResolvedValue({
      message: { content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 10, outputTokens: 3 },
    });

    const result = await gateway.runToolTurn({
      operation: 'assignment_pipeline',
      workspaceId: 1,
      messages: [],
      tools: [],
    });

    expect(result).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      attemptNumber: 1,
      fallbackUsed: false,
    });
    expect(openAiToolResponseMock).not.toHaveBeenCalled();
    expect(prismaMock.aiProviderAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'succeeded', inputTokens: 10, outputTokens: 3 }),
    }));
    expect(recordSuccessMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }));
  });

  test('falls back from Anthropic to OpenAI on retryable provider failure', async () => {
    setAttempts([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      {
        provider: 'openai',
        model: 'gpt-5.5',
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'primary_request_failed',
      },
    ]);
    const rateLimitError = new Error('rate limit exceeded');
    rateLimitError.status = 429;
    anthropicToolResponseMock.mockRejectedValue(rateLimitError);
    openAiToolResponseMock.mockResolvedValue({
      message: { content: [{ type: 'text', text: 'fallback ok' }] },
      usage: { inputTokens: 8, outputTokens: 4 },
    });
    const emit = jest.fn();

    const result = await gateway.runToolTurn({
      operation: 'assignment_pipeline',
      workspaceId: 1,
      messages: [],
      tools: [],
      emit,
    });

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      attemptNumber: 2,
      fallbackUsed: true,
      fallbackFromProvider: 'anthropic',
      fallbackReason: 'primary_request_failed',
    });
    expect(recordFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic',
      error: rateLimitError,
    }));
    expect(recordSuccessMock).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'provider_attempt_failed', errorClass: 'rate_limited' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'provider_fallback_started', provider: 'openai' }));
  });

  test('does not fall back on schema validation failure', async () => {
    setAttempts([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      {
        provider: 'openai',
        model: 'gpt-5.5',
        fallbackFromProvider: 'anthropic',
        fallbackReason: 'primary_request_failed',
      },
    ]);
    const schemaError = new Error('schema validation failed');
    schemaError.code = 'schema_validation';
    anthropicToolResponseMock.mockRejectedValue(schemaError);

    await expect(gateway.runToolTurn({
      operation: 'assignment_pipeline',
      workspaceId: 1,
      messages: [],
      tools: [],
    })).rejects.toThrow('schema validation failed');

    expect(openAiToolResponseMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic',
      error: schemaError,
    }));
  });
});
