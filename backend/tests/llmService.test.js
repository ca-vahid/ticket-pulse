import { jest } from '@jest/globals';

const sendJsonMock = jest.fn();
const getPublishedConfigMock = jest.fn();
const applyOverrideRulesMock = jest.fn();
const isDomainAllowedMock = jest.fn();
const replacePlaceholdersMock = jest.fn();

jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: { sendJson: sendJsonMock },
}));

jest.unstable_mockModule('../src/services/llmConfigService.js', () => ({
  default: {
    getPublishedConfig: getPublishedConfigMock,
    applyOverrideRules: applyOverrideRulesMock,
    isDomainAllowed: isDomainAllowedMock,
    replacePlaceholders: replacePlaceholdersMock,
  },
}));

jest.unstable_mockModule('../src/config/index.js', () => ({
  default: {
    openai: { model: 'gpt-5.5' },
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { default: llmService } = await import('../src/services/llmService.js');

function baseConfig() {
  return {
    model: 'gpt-5.5',
    classificationPrompt: 'Classify {{subject}}',
    responsePrompt: 'Respond to {{senderName}}',
    overrideRules: [],
    domainWhitelist: [],
    domainBlacklist: [],
    tonePresets: {
      human_request: { instructions: 'Be helpful' },
    },
    reasoningEffort: 'none',
    verbosity: 'medium',
    maxOutputTokens: 800,
    signatureBlock: 'IT Support',
    fallbackMessage: 'Fallback response',
  };
}

describe('llmService provider gateway integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPublishedConfigMock.mockResolvedValue(baseConfig());
    applyOverrideRulesMock.mockReturnValue(null);
    isDomainAllowedMock.mockReturnValue(true);
    replacePlaceholdersMock.mockImplementation((template) => template);
  });

  test('classifies through the provider gateway with workspace operation routing', async () => {
    sendJsonMock.mockResolvedValue({
      parsed: {
        sourceType: 'human_request',
        severity: 'medium',
        requiresPersonalResponse: true,
        category: 'password_reset',
        summary: 'Password reset request',
        confidence: 0.9,
        reasoning: 'User asked for password help.',
      },
      usage: { totalTokens: 25 },
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackUsed: false,
    });

    const result = await llmService.classifyTicket({
      workspaceId: 7,
      subject: 'Password reset',
      body: 'Help',
      senderEmail: 'user@example.com',
      senderName: 'User',
    });

    expect(sendJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'autoresponse_classification',
      workspaceId: 7,
      legacyModel: 'gpt-5.5',
      maxTokens: 600,
    }));
    expect(result).toMatchObject({
      classification: expect.objectContaining({ category: 'password_reset' }),
      tokensUsed: 25,
      provider: 'openai',
      model: 'gpt-5.5',
      fallbackUsed: false,
    });
  });

  test('generates response through the provider gateway and appends signature', async () => {
    sendJsonMock.mockResolvedValue({
      parsed: {
        subject: 'Re: Password reset',
        body: 'We received your request.',
        tone: 'professional',
      },
      usage: { inputTokens: 10, outputTokens: 15 },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbackUsed: true,
      fallbackReason: 'primary_request_failed',
    });

    const result = await llmService.generateResponse({
      workspaceId: 7,
      classification: {
        sourceType: 'human_request',
        category: 'password_reset',
        severity: 'medium',
        summary: 'Password reset request',
      },
      senderName: 'User',
      senderEmail: 'user@example.com',
      subject: 'Password reset',
      isAfterHours: false,
      isHoliday: false,
    });

    expect(sendJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'autoresponse_generation',
      workspaceId: 7,
      legacyModel: 'gpt-5.5',
    }));
    expect(result).toMatchObject({
      response: {
        subject: 'Re: Password reset',
        body: 'We received your request.\n\nIT Support',
        tone: 'professional',
      },
      tokensUsed: 25,
      provider: 'anthropic',
      fallbackUsed: true,
      fallbackReason: 'primary_request_failed',
    });
  });

  test('uses configured fallback response after both providers fail', async () => {
    sendJsonMock.mockRejectedValue(new Error('provider down'));

    const result = await llmService.generateResponse({
      workspaceId: 7,
      classification: {
        sourceType: 'human_request',
        category: 'general',
        severity: 'medium',
        summary: 'General request',
      },
      senderName: 'User',
      senderEmail: 'user@example.com',
      subject: 'Help',
      isAfterHours: false,
      isHoliday: false,
    });

    expect(result.response).toMatchObject({
      subject: 'Re: Help',
      tone: 'fallback',
    });
    expect(result.response.body).toContain('Fallback response');
    expect(result.error).toBe('provider down');
  });
});
