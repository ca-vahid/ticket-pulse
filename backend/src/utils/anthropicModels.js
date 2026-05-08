export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_RECLASSIFICATION_MODEL = 'claude-haiku-4-5-20251001';

const LEGACY_MODEL_ALIASES = new Map([
  ['claude-sonnet-4-6-20260217', DEFAULT_ANTHROPIC_MODEL],
]);

export function normalizeAnthropicModel(model, fallbackModel = DEFAULT_ANTHROPIC_MODEL) {
  const value = String(model || '').trim();
  if (!value) return fallbackModel;
  return LEGACY_MODEL_ALIASES.get(value) || value;
}
