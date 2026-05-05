export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

const LEGACY_MODEL_ALIASES = new Map([
  ['claude-sonnet-4-6-20260217', DEFAULT_ANTHROPIC_MODEL],
]);

export function normalizeAnthropicModel(model) {
  const value = String(model || '').trim();
  if (!value) return DEFAULT_ANTHROPIC_MODEL;
  return LEGACY_MODEL_ALIASES.get(value) || value;
}
