import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_RECLASSIFICATION_MODEL,
  normalizeAiModel,
} from './aiProviders.js';

export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_RECLASSIFICATION_MODEL };

export function normalizeAnthropicModel(model, fallbackModel = DEFAULT_ANTHROPIC_MODEL) {
  return normalizeAiModel(model, 'anthropic', fallbackModel);
}
