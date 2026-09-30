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
  'notification_workflow_generation',
  // On-demand agent-facing thread summary (ticketSummaryService).
  'ticket_thread_summary',
  // Requester-sentiment classification (gap plan 2 P5.1) — cheap tier.
  'requester_sentiment',
  // Analytics Reports narrative (feedback 07-14) — meeting-brief writing.
  'analytics_report',
  // Autofill intake extraction (Phase AF): multimodal — pasted text + screenshots
  // → proposed ticket fields. Requires a vision-capable model (see
  // supportsVision / modelSupportsVision); deliberately NOT on the Haiku tier.
  'ticket_intake_extract',
  // Auto-help (plans/AUTO_HELP_PLAN.md): playbook-grounded first answers,
  // tool loop over knowledge articles / resolved tickets. Shadow-only in P0.
  'auto_help',
];

// Sonnet 5.5 (released 28 Sep 2026: same $2/$10 price as Sonnet 5, >30%
// faster output, same tokenizer) is the default. Sonnet 5 and Sonnet 4.6 stay
// selectable in the settings dropdown for opt-back.
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
export const SONNET_5_MODEL = 'claude-sonnet-5';
export const SONNET_4_6_MODEL = 'claude-sonnet-4-6';
// GPT-6 Sol (released 22 Sep 2026, verified 23 Sep against the prod key: tool
// call + history replay + image input through OpenAiProvider). $2/M in, $10/M
// out, cached reads 90% off and no cache-write fee — the default OpenAI slot,
// replacing GPT-5.6 Sol ($5/$30).
export const DEFAULT_OPENAI_MODEL = 'gpt-6-sol';
export const OPENAI_ECONOMY_MODEL = 'gpt-6-luna';
// GPT-6.1 Sol (29 Sep 2026): same $2/$10 as GPT-6 Sol, cached reads $0.10
// (vs $0.20), fewer factual errors. Selectable; replaces GPT-6 Sol per
// operation only after a replay against real tickets.
export const GPT_6_1_SOL_MODEL = 'gpt-6.1-sol';

/**
 * Per-model request rules for OpenAI (30 Sep 2026): GPT-6.1 rejects
 * reasoning.effort 'none' (400 unsupported_value; supports low … max), which
 * our JSON calls ask for — it runs at 'low' instead. Other models unchanged.
 */
const OPENAI_MIN_REASONING = [['gpt-6.1', 'low']];
/**
 * GPT-6.1 also rejects `temperature` (400 "Unsupported parameter", seen in
 * the 30 Sep replay of IT's workflow e-mails) — it is left out for them.
 */
const OPENAI_NO_TEMPERATURE = ['gpt-6.1'];
export function openAiOmitsTemperature(model) {
  const m = String(model || '').toLowerCase();
  return OPENAI_NO_TEMPERATURE.some((prefix) => m.startsWith(prefix));
}

export function openAiReasoningFor(model, requested) {
  const effort = requested?.effort;
  const rule = OPENAI_MIN_REASONING.find(([prefix]) => String(model || '').toLowerCase().startsWith(prefix));
  if (!rule || (effort !== 'none' && effort !== 'minimal')) return requested;
  return { ...requested, effort: rule[1] };
}
export const DEFAULT_RECLASSIFICATION_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_OPUS_MODEL = 'claude-opus-4-8';

const ALL_OPERATIONS = new Set(AI_OPERATIONS);

const LEGACY_MODEL_ALIASES = new Map([
  ['claude-sonnet-4-6-20260217', SONNET_4_6_MODEL],
  // Preserve saved settings created before the Opus 4.8 launch.
  ['claude-opus-4-7', DEFAULT_OPUS_MODEL],
  ['gpt-5.1', DEFAULT_OPENAI_MODEL],
  ['gpt-5', DEFAULT_OPENAI_MODEL],
  ['gpt-5-mini', DEFAULT_OPENAI_MODEL],
  ['gpt-5-nano', DEFAULT_OPENAI_MODEL],
  // Saved settings created while gpt-5.5 / gpt-5.6-sol were the default read
  // as GPT-6 Sol (23 Sep 2026). The settings rows themselves are rewritten by
  // scripts/migrate-openai-models-gpt6.mjs so Settings shows what runs.
  ['gpt-5.5', DEFAULT_OPENAI_MODEL],
  ['gpt-5.6-sol', DEFAULT_OPENAI_MODEL],
  // gpt-5.6-luna is NOT aliased: it runs as ws2's assignment fallback and Luna 6
  // has not been shadow-tested on assignment (plans/AI_MODEL_COST_PLAN.md §3).
]);

export const MODEL_METADATA = [
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: DEFAULT_ANTHROPIC_MODEL,
    label: 'Claude Sonnet 5.5',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: false,
    supportsVision: true,
    costNotes: 'Default quality model for assignment automation. Same price as Sonnet 5, faster, fewer tool calls per task.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: SONNET_5_MODEL,
    label: 'Claude Sonnet 5',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: false,
    supportsVision: true,
    costNotes: 'Previous Sonnet default; kept selectable for opt-back.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: SONNET_4_6_MODEL,
    label: 'Claude Sonnet 4.6',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: false,
    supportsVision: true,
    costNotes: 'Previous-generation Sonnet; kept selectable for opt-back.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: DEFAULT_RECLASSIFICATION_MODEL,
    label: 'Claude Haiku 4.5',
    // Explicit allow-list: the cheap tier never sees image-bearing ops
    // (ticket_intake_extract stays out on purpose).
    operations: ['ticket_reclassification', 'calendar_leave', 'requester_sentiment'],
    supportsStreaming: false,
    supportsTools: false,
    supportsJson: true,
    supportsThinking: false,
    supportsVision: false,
    costNotes: 'Lower-cost batch and classification model.',
  },
  {
    provider: AI_PROVIDER_ANTHROPIC,
    model: DEFAULT_OPUS_MODEL,
    label: 'Claude Opus 4.8 (Expensive)',
    operations: AI_OPERATIONS,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    supportsVision: true,
    costNotes: 'Expensive frontier model; use selectively for workflows that justify the extra cost.',
  },
  {
    provider: AI_PROVIDER_OPENAI,
    model: DEFAULT_OPENAI_MODEL,
    label: 'GPT-6 Sol',
    operations: AI_OPERATIONS,
    supportsStreaming: false,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    // Image input verified live 23 Sep 2026 (Responses `input_image`).
    supportsVision: true,
    costNotes: 'Default OpenAI model: roughly Sonnet-class on business workflows at about two-thirds the price ($2/M in, $10/M out, cached reads 90% off, no cache-write fee). Replaces GPT-5.6 Sol.',
  },
  {
    provider: AI_PROVIDER_OPENAI,
    model: GPT_6_1_SOL_MODEL,
    label: 'GPT-6.1 Sol',
    operations: AI_OPERATIONS,
    supportsStreaming: false,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    supportsVision: true,
    costNotes: 'Successor to GPT-6 Sol at the same price ($2/M in, $10/M out) with cached reads at $0.10 and fewer factual errors (OpenAI: 7.7% vs 11.4%). Behind Sonnet 5.5 on tool-heavy agent work.',
  },
  {
    provider: AI_PROVIDER_OPENAI,
    model: OPENAI_ECONOMY_MODEL,
    label: 'GPT-6 Luna (Economy)',
    operations: AI_OPERATIONS,
    supportsStreaming: false,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    supportsVision: true,
    costNotes: 'Economy model ($0.10/M in, $0.50/M out): drafting and classification. Not for assignment until shadow-tested — GPT-5.6 Luna over-dismissed invoices as noise (Aug 2026).',
  },
  {
    provider: AI_PROVIDER_OPENAI,
    model: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna (legacy economy)',
    operations: AI_OPERATIONS,
    supportsStreaming: false,
    supportsTools: true,
    supportsJson: true,
    supportsThinking: true,
    // Luna accepts text + image input like Sol (same 5.6 family, per OpenAI's
    // model page) — the economy tier is a valid autofill fallback.
    supportsVision: true,
    // Priced Jul 30 2026 after OpenAI's 80% cut: $0.20/M input, $1.20/M output
    // (vs Sonnet 5 $3/$15) — ~90% cheaper on the Accounting workload profile.
    costNotes: 'Economy model for high-volume workspaces (e.g. invoice triage). ~10x cheaper than Sonnet-class; suited to classification and lightweight agentic runs, not the hardest reasoning.',
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

export function shouldOmitAnthropicTemperature(model) {
  const normalized = normalizeModelAlias(model);
  const value = String(normalized || '').trim().toLowerCase();
  if (value === DEFAULT_OPUS_MODEL || value.startsWith(`${DEFAULT_OPUS_MODEL}-`)) return true;
  // Sonnet 5 and Sonnet 5.5 (claude-sonnet-5-5) reject non-default sampling
  // params (400), unlike Sonnet 4.6.
  return value === 'claude-sonnet-5' || value.startsWith('claude-sonnet-5-');
}

/**
 * Request shape a Claude model accepts (Sonnet 5.5 migration, 28 Sep 2026).
 * Sonnet 5.5, Opus 5.5 and Fable 5.1 reject `thinking: {type: 'disabled'}`
 * (400; the lowest setting is `between_tools` on Sonnet 5.5, adaptive at low
 * effort on the others) and forced `tool_choice` ('any' / 'tool').
 * @returns {{ thinkingOff: object|null, forcedToolChoice: boolean }}
 *   thinkingOff: what to send for "no up-front thinking" (null = omit the field)
 */
export function anthropicRequestRules(model) {
  const value = String(normalizeModelAlias(model) || '').trim().toLowerCase();
  const is = (id) => value === id || value.startsWith(`${id}-`);
  if (is('claude-sonnet-5-5')) return { thinkingOff: { type: 'between_tools' }, forcedToolChoice: false };
  if (is('claude-opus-5-5') || is('claude-fable-5-1') || is('claude-mythos-5-1')) return { thinkingOff: null, forcedToolChoice: false };
  return { thinkingOff: { type: 'disabled' }, forcedToolChoice: true };
}

export function defaultModelForProvider(provider, operation = null) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === AI_PROVIDER_OPENAI) return DEFAULT_OPENAI_MODEL;
  if (operation === 'ticket_reclassification' || operation === 'calendar_leave' || operation === 'requester_sentiment') {
    return DEFAULT_RECLASSIFICATION_MODEL;
  }
  if (operation === 'daily_review_consolidation') {
    return DEFAULT_OPUS_MODEL;
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

/**
 * Whether a model can accept image content blocks. Unknown (unregistered)
 * models are treated as NOT vision-capable: the resolver uses this to refuse
 * image-bearing calls up front instead of sending them into a provider 400.
 */
export function modelSupportsVision(model, provider = null) {
  const normalizedProvider = normalizeProvider(provider || providerForModel(model) || AI_PROVIDER_ANTHROPIC);
  const normalizedModel = normalizeAiModel(model, normalizedProvider);
  const metadata = MODEL_METADATA.find((entry) => (
    entry.provider === normalizedProvider && entry.model === normalizedModel
  ));
  return metadata ? metadata.supportsVision === true : false;
}

export function getModelMetadata({ provider = null, operation = null } = {}) {
  const normalizedProvider = provider ? normalizeProvider(provider) : null;
  return MODEL_METADATA
    .filter((entry) => !normalizedProvider || entry.provider === normalizedProvider)
    .filter((entry) => !operation || entry.operations.includes(operation));
}

export function getDefaultProviderSetting(operation = 'assignment_pipeline', legacyModel = null) {
  const defaultPrimaryProvider = operation === 'autoresponse_classification'
    || operation === 'autoresponse_generation'
    || operation === 'notification_workflow_generation'
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
