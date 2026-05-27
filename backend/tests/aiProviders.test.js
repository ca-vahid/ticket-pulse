import {
  AI_PROVIDER_ANTHROPIC,
  AI_PROVIDER_OPENAI,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_RECLASSIFICATION_MODEL,
  defaultModelForProvider,
  getDefaultProviderSetting,
  getModelMetadata,
  isAnthropicModel,
  isOpenAiModel,
  normalizeAiModel,
  providerForModel,
  supportsOperation,
} from '../src/utils/aiProviders.js';

describe('ai provider utilities', () => {
  test('detects provider families from model names', () => {
    expect(isAnthropicModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicModel('gpt-5.1')).toBe(false);
    expect(isOpenAiModel('gpt-5.1')).toBe(true);
    expect(isOpenAiModel('o4-mini')).toBe(true);
    expect(providerForModel('claude-haiku-4-5-20251001')).toBe(AI_PROVIDER_ANTHROPIC);
    expect(providerForModel('gpt-5.1')).toBe(AI_PROVIDER_OPENAI);
  });

  test('normalizes legacy and mismatched models conservatively', () => {
    expect(normalizeAiModel('claude-sonnet-4-6-20260217', AI_PROVIDER_ANTHROPIC))
      .toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(normalizeAiModel('gpt-5.1', AI_PROVIDER_ANTHROPIC))
      .toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(normalizeAiModel('claude-sonnet-4-6', AI_PROVIDER_OPENAI))
      .toBe(DEFAULT_OPENAI_MODEL);
  });

  test('uses operation-specific defaults and support checks', () => {
    expect(defaultModelForProvider(AI_PROVIDER_ANTHROPIC, 'ticket_reclassification'))
      .toBe(DEFAULT_RECLASSIFICATION_MODEL);
    expect(supportsOperation(DEFAULT_RECLASSIFICATION_MODEL, AI_PROVIDER_ANTHROPIC, 'ticket_reclassification'))
      .toBe(true);
    expect(supportsOperation(DEFAULT_RECLASSIFICATION_MODEL, AI_PROVIDER_ANTHROPIC, 'assignment_pipeline'))
      .toBe(false);
  });

  test('exposes only the approved GPT-5.5 option and marks Opus as expensive', () => {
    const openAiModels = getModelMetadata({
      provider: AI_PROVIDER_OPENAI,
      operation: 'assignment_pipeline',
    });
    expect(openAiModels).toEqual([
      expect.objectContaining({
        model: DEFAULT_OPENAI_MODEL,
        label: 'GPT-5.5',
      }),
    ]);

    const anthropicModels = getModelMetadata({
      provider: AI_PROVIDER_ANTHROPIC,
      operation: 'assignment_pipeline',
    });
    expect(anthropicModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: 'claude-opus-4-7',
        label: expect.stringContaining('Expensive'),
      }),
    ]));
  });

  test('builds opposite-provider fallback defaults', () => {
    expect(getDefaultProviderSetting('assignment_pipeline', 'claude-sonnet-4-6')).toMatchObject({
      primaryProvider: AI_PROVIDER_ANTHROPIC,
      primaryModel: DEFAULT_ANTHROPIC_MODEL,
      fallbackProvider: AI_PROVIDER_OPENAI,
      fallbackModel: DEFAULT_OPENAI_MODEL,
      autoFallbackEnabled: true,
    });
    expect(getDefaultProviderSetting('assignment_pipeline', 'gpt-5.1')).toMatchObject({
      primaryProvider: AI_PROVIDER_OPENAI,
      primaryModel: DEFAULT_OPENAI_MODEL,
      fallbackProvider: AI_PROVIDER_ANTHROPIC,
      fallbackModel: DEFAULT_ANTHROPIC_MODEL,
    });
    expect(getDefaultProviderSetting('autoresponse_generation')).toMatchObject({
      primaryProvider: AI_PROVIDER_OPENAI,
      primaryModel: DEFAULT_OPENAI_MODEL,
      fallbackProvider: AI_PROVIDER_ANTHROPIC,
      fallbackModel: DEFAULT_ANTHROPIC_MODEL,
    });
  });
});
