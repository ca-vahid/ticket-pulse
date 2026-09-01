import {
  AI_OPERATIONS,
  AI_PROVIDER_ANTHROPIC,
  AI_PROVIDER_OPENAI,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPUS_MODEL,
  DEFAULT_RECLASSIFICATION_MODEL,
  MODEL_METADATA,
  SONNET_4_6_MODEL,
  defaultModelForProvider,
  getDefaultProviderSetting,
  getModelMetadata,
  isAnthropicModel,
  isOpenAiModel,
  modelSupportsVision,
  normalizeAiModel,
  providerForModel,
  shouldOmitAnthropicTemperature,
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
    // The dated 4.6 alias canonicalizes to plain 4.6 (still a valid,
    // selectable model) — the Sonnet 5 upgrade of saved rows happens in the
    // 20260712000000_sonnet_5_default migration, not via aliasing.
    expect(normalizeAiModel('claude-sonnet-4-6-20260217', AI_PROVIDER_ANTHROPIC))
      .toBe(SONNET_4_6_MODEL);
    expect(normalizeAiModel('claude-opus-4-7', AI_PROVIDER_ANTHROPIC, null, 'daily_review_consolidation'))
      .toBe(DEFAULT_OPUS_MODEL);
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

  test('omits deprecated temperature for Opus 4.8, Sonnet 5, and legacy aliases', () => {
    expect(shouldOmitAnthropicTemperature(DEFAULT_OPUS_MODEL)).toBe(true);
    expect(shouldOmitAnthropicTemperature('claude-opus-4-7')).toBe(true);
    // Sonnet 5 (the default) rejects non-default sampling params with a 400.
    expect(shouldOmitAnthropicTemperature(DEFAULT_ANTHROPIC_MODEL)).toBe(true);
    expect(shouldOmitAnthropicTemperature(SONNET_4_6_MODEL)).toBe(false);
    expect(shouldOmitAnthropicTemperature(DEFAULT_RECLASSIFICATION_MODEL)).toBe(false);
  });

  test('exposes only the approved OpenAI options and marks Opus as expensive', () => {
    const openAiModels = getModelMetadata({
      provider: AI_PROVIDER_OPENAI,
      operation: 'assignment_pipeline',
    });
    // Approved set: GPT-5.6 Sol (default/fallback, successor to GPT-5.5) +
    // GPT-5.6 Luna (economy tier,
    // added Aug 2026 after OpenAI's 80% price cut — ~10x cheaper than Sonnet).
    expect(openAiModels).toEqual([
      expect.objectContaining({
        model: DEFAULT_OPENAI_MODEL,
        label: 'GPT-5.6 Sol',
      }),
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        label: expect.stringContaining('Economy'),
      }),
    ]);

    const anthropicModels = getModelMetadata({
      provider: AI_PROVIDER_ANTHROPIC,
      operation: 'assignment_pipeline',
    });
    expect(anthropicModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model: DEFAULT_OPUS_MODEL,
        label: expect.stringContaining('Expensive'),
      }),
    ]));
  });

  test('builds opposite-provider fallback defaults', () => {
    // A saved legacy 4.6 selection is preserved as-is (upgrade happens via migration).
    expect(getDefaultProviderSetting('assignment_pipeline', 'claude-sonnet-4-6')).toMatchObject({
      primaryProvider: AI_PROVIDER_ANTHROPIC,
      primaryModel: SONNET_4_6_MODEL,
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

describe('ticket_intake_extract registration (Phase AF)', () => {
  test('the op is registered and every model that may run it can read images', () => {
    expect(AI_OPERATIONS).toContain('ticket_intake_extract');
    const eligible = getModelMetadata({ operation: 'ticket_intake_extract' });
    expect(eligible.length).toBeGreaterThan(0);
    for (const entry of eligible) {
      expect(entry.supportsVision).toBe(true);
    }
    // Sonnet 5 / 4.6 / Opus 4.8 and both GPT-5.6 tiers are all eligible.
    expect(eligible.map((entry) => entry.model)).toEqual(expect.arrayContaining([
      DEFAULT_ANTHROPIC_MODEL, SONNET_4_6_MODEL, DEFAULT_OPUS_MODEL, DEFAULT_OPENAI_MODEL, 'gpt-5.6-luna',
    ]));
  });

  test('Haiku is excluded from the op and marked non-vision', () => {
    expect(supportsOperation(DEFAULT_RECLASSIFICATION_MODEL, AI_PROVIDER_ANTHROPIC, 'ticket_intake_extract')).toBe(false);
    expect(getModelMetadata({ operation: 'ticket_intake_extract' }).map((entry) => entry.model))
      .not.toContain(DEFAULT_RECLASSIFICATION_MODEL);
    expect(modelSupportsVision(DEFAULT_RECLASSIFICATION_MODEL, AI_PROVIDER_ANTHROPIC)).toBe(false);
  });

  test('every MODEL_METADATA entry declares supportsVision as a boolean', () => {
    for (const entry of MODEL_METADATA) {
      expect(typeof entry.supportsVision).toBe('boolean');
    }
  });

  test('modelSupportsVision resolves aliases and treats unknown models as non-vision', () => {
    expect(modelSupportsVision(DEFAULT_ANTHROPIC_MODEL, AI_PROVIDER_ANTHROPIC)).toBe(true);
    expect(modelSupportsVision('claude-sonnet-4-6-20260217')).toBe(true); // legacy alias -> 4.6
    expect(modelSupportsVision(DEFAULT_OPENAI_MODEL, AI_PROVIDER_OPENAI)).toBe(true);
    expect(modelSupportsVision('gpt-5.6-luna')).toBe(true);
    expect(modelSupportsVision('gpt-5.5')).toBe(true); // alias -> Sol
    expect(modelSupportsVision('gpt-4o-custom-unknown', AI_PROVIDER_OPENAI)).toBe(false);
  });

  test('defaults for the op stay on the Sonnet / Sol tiers', () => {
    expect(defaultModelForProvider(AI_PROVIDER_ANTHROPIC, 'ticket_intake_extract')).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(defaultModelForProvider(AI_PROVIDER_OPENAI, 'ticket_intake_extract')).toBe(DEFAULT_OPENAI_MODEL);
  });
});
