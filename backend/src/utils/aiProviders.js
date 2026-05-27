export const AI_PROVIDER_ANTHROPIC = 'anthropic';
export const AI_PROVIDER_OPENAI = 'openai';

export const AI_PROVIDERS = [AI_PROVIDER_ANTHROPIC, AI_PROVIDER_OPENAI];

export const AI_OPERATIONS = [
  'assignment_pipeline',
  'competency_analysis',
  'daily_review',
  'daily_review_consolidation',
  'ticket_reclassification',
  'calendar_leave',
  'autoresponse_classification',
  'autoresponse_generation',
];

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
export const DEFAULT_RECLASSIFICATION_MODEL = 'claude-haiku-4-5-20251001';

const ALL_OPERATIONS = new Set(AI_OPERATIONS);

const LEGACY_MODEL_ALIASES = new Map([
  ['claude-sonnet-4-6-20260217', DEFAULT_ANTHROPIC_MODEL],
  ['gpt-5.1', DEFAULT_OPENAI_MODEL],
  ['gpt-5', DEFAULT_OPENAI_MODEL],
  ['gpt-5-mini', DEFAULT_OPENAI_MODEL],
  ['gpt-5-nano', DEFAULT_OPENAI_MODEL],
]);

export const MODEL_METADATA = [
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: DEFAULT_ANTHROPIC_MODEL,
    label: 'Claude Sonnet 4.6',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: false,
    costNotes: 'Default quality model for assignment automation.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: DEFAULT_RECLASSIFICATION_MODEL,
    label: 'Claude Haiku 4.5',
    operations: ['ticket_reclassification', 'calendar_leave'],
    supportsStreaming: false,
    supportsTools: false,
    supportsJson: true,
    supportsThinking: false,
    costNotes: 'Lower-cost batch and classification model.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: 'claude-opus-4-7',
    label: 'Claude Opus 4.7 (Expensive)',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    costNotes: 'Expensive frontier model; use selectively for workflows that justify the extra cost.',
  },
  {
    provider: AI_PROVIDER_OPENAI,
    model: DEFAULT_OPENAI_MODEL,
    label: 'GPT-5.5',
    operations: AI_OPERATIONS,
    supportsStreaming: false,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    costNotes: 'Default OpenAI fallback model. Tune reasoning effort instead of selecting a separate pro model.',
  },
];

export function normalizeProvider(provider, fallbackProvider = AI_PROVIDER_ANTHROPIC) {
  const value = String(provider || '').trim().toLowerCase();
  return AI_PROVIDERS.includes(value) ? value : fallbackProvider;
}

export function isAnthropicModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return value.startsWith('claude-');
}

export function isOpenAiModel(model) {
  const value = String(model || '').trim().toLowerCase();
  return (
    value.startsWith('gpt-')
    || value.startsWith('o1')
    || value.startsWith('o3')
    || value.startsWith('o4-')
  );
}

export function providerForModel(model, fallbackProvider = null) {
  const normalized = normalizeModelAlias(model);
  if (isAnthropicModel(normalized)) return AI_PROVIDER_ANTHROPIC;
  if (isOpenAiModel(normalized)) return AI_PROVIDER_OPENAI;
  return fallbackProvider;
}

export function normalizeModelAlias(model) {
  const value = String(model || '').trim();
  if (!value) return value;
  return LEGACY_MODEL_ALIASES.get(value) || value;
}

export function defaultModelForProvider(provider, operation = null) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === AI_PROVIDER_OPENAI) return DEFAULT_OPENAI_MODEL;
  if (operation === 'ticket_reclassification' || operation === 'calendar_leave') {
    return DEFAULT_RECLASSIFICATION_MODEL;
  }
  if (operation === 'daily_review_consolidation') {
    return 'claude-opus-4-7';
  }
  return DEFAULT_ANTHROPIC_MODEL;
}

export function normalizeAiModel(model, provider = null, fallbackModel = null, operation = null) {
  const inferredProvider = normalizeProvider(provider || providerForModel(model) || AI_PROVIDER_ANTHROPIC);
  const fallback = fallbackModel || defaultModelForProvider(inferredProvider, operation);
  const normalized = normalizeModelAlias(model);
  if (!normalized) return fallback;
  const modelProvider = providerForModel(normalized, inferredProvider);
  if (modelProvider !== inferredProvider) return fallback;
  return normalized;
}

export function supportsOperation(model, provider, operation) {
  if (!ALL_OPERATIONS.has(operation)) return false;
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeAiModel(model, normalizedProvider, null, operation);
  const metadata = MODEL_METADATA.find((entry) => (
    entry.provider === normalizedProvider && entry.model === normalizedModel
  ));
  if (!metadata) {
    return normalizedProvider === providerForModel(normalizedModel, normalizedProvider);
  }
  return metadata.operations.includes(operation);
}

export function getModelMetadata({ provider = null, operation = null } = {}) {
  const normalizedProvider = provider ? normalizeProvider(provider) : null;
  return MODEL_METADATA
    .filter((entry) => !normalizedProvider || entry.provider === normalizedProvider)
    .filter((entry) => !operation || entry.operations.includes(operation));
}

export function getDefaultProviderSetting(operation = 'assignment_pipeline', legacyModel = null) {
  const defaultPrimaryProvider = operation === 'autoresponse_classification' || operation === 'autoresponse_generation'
    ? AI_PROVIDER_OPENAI
    : AI_PROVIDER_ANTHROPIC;
  const primaryProvider = providerForModel(legacyModel, defaultPrimaryProvider);
  return {
    operation,
    primaryProvider,
    primaryModel: normalizeAiModel(legacyModel, primaryProvider, null, operation),
    fallbackProvider: primaryProvider === AI_PROVIDER_OPENAI ? AI_PROVIDER_ANTHROPIC : AI_PROVIDER_OPENAI,
    fallbackModel: primaryProvider === AI_PROVIDER_OPENAI
      ? defaultModelForProvider(AI_PROVIDER_ANTHROPIC, operation)
      : defaultModelForProvider(AI_PROVIDER_OPENAI, operation),
    autoFallbackEnabled: true,
    fallbackMode: 'retry_safe_checkpoint',
  };
}
