import config from '../../config/index.js';
import {
  modelSupportsVision,
  normalizeAiModel,
  normalizeProvider,
  providerForModel,
  supportsOperation,
} from '../../utils/aiProviders.js';
import providerHealthService from './providerHealthService.js';
import providerSettingsService from './providerSettingsService.js';

export function isProviderConfigured(provider) {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic') return !!config.anthropic.apiKey;
  if (normalized === 'openai') return !!config.openai.apiKey;
  return false;
}

class ProviderModelResolver {
  async resolveAttempts({
    workspaceId,
    operation,
    legacyModel = null,
    preferredProvider = null,
    preferredModel = null,
    // Set by callers whose userMessage carries image blocks (Phase AF
    // autofill). Non-vision models are refused here rather than at the
    // provider, where they would surface as an opaque 400.
    requiresVision = false,
  }) {
    const setting = await providerSettingsService.getSetting(workspaceId, operation, preferredModel || legacyModel);
    const primaryProvider = normalizeProvider(
      preferredProvider || setting.primaryProvider || providerForModel(preferredModel || legacyModel) || 'anthropic',
    );
    const primaryModel = normalizeAiModel(
      preferredModel || setting.primaryModel || legacyModel,
      primaryProvider,
      null,
      operation,
    );
    const fallbackProvider = setting.fallbackProvider
      ? normalizeProvider(setting.fallbackProvider)
      : (primaryProvider === 'anthropic' ? 'openai' : 'anthropic');
    let fallbackModel = setting.fallbackModel
      ? normalizeAiModel(setting.fallbackModel, fallbackProvider, null, operation)
      : null;

    if (!supportsOperation(primaryModel, primaryProvider, operation)) {
      throw new Error(`Model ${primaryModel} does not support ${operation}`);
    }
    if (fallbackModel && !supportsOperation(fallbackModel, fallbackProvider, operation)) {
      throw new Error(`Fallback model ${fallbackModel} does not support ${operation}`);
    }

    // Vision gate: a primary that cannot read images is a hard error; a
    // non-vision fallback is dropped (better one honest attempt than a
    // guaranteed 400 on the second).
    let visionFallbackDropped = false;
    if (requiresVision && !modelSupportsVision(primaryModel, primaryProvider)) {
      throw new Error(`Model ${primaryModel} does not support image input required by ${operation}`);
    }
    if (requiresVision && fallbackModel && !modelSupportsVision(fallbackModel, fallbackProvider)) {
      fallbackModel = null;
      visionFallbackDropped = true;
    }

    const primaryHealth = await providerHealthService.getStatus(primaryProvider, operation, workspaceId);
    const fallbackHealth = fallbackProvider
      ? await providerHealthService.getStatus(fallbackProvider, operation, workspaceId)
      : null;

    const attempts = [];
    const primaryConfigured = isProviderConfigured(primaryProvider);
    const primaryRouteable = primaryConfigured && primaryHealth.routingEligible !== false;
    const fallbackConfigured = fallbackProvider ? isProviderConfigured(fallbackProvider) : false;
    const fallbackRouteable = fallbackProvider
      && fallbackModel
      && fallbackConfigured
      && fallbackHealth?.routingEligible !== false;

    if (!primaryRouteable && setting.autoFallbackEnabled && fallbackRouteable) {
      attempts.push({
        provider: fallbackProvider,
        model: fallbackModel,
        fallbackFromProvider: primaryProvider,
        fallbackReason: primaryConfigured ? `primary_${primaryHealth.status}` : 'primary_config_missing',
        healthStatus: fallbackHealth?.status || 'unknown',
      });
      return {
        setting,
        primary: { provider: primaryProvider, model: primaryModel, health: primaryHealth },
        fallback: { provider: fallbackProvider, model: fallbackModel, health: fallbackHealth },
        visionFallbackDropped,
        attempts,
      };
    }

    attempts.push({
      provider: primaryProvider,
      model: primaryModel,
      fallbackFromProvider: null,
      fallbackReason: null,
      healthStatus: primaryHealth.status,
    });

    if (
      setting.autoFallbackEnabled
      && fallbackProvider
      && fallbackModel
      && fallbackProvider !== primaryProvider
    ) {
      attempts.push({
        provider: fallbackProvider,
        model: fallbackModel,
        fallbackFromProvider: primaryProvider,
        fallbackReason: 'primary_request_failed',
        healthStatus: fallbackHealth?.status || 'unknown',
      });
    }

    return {
      setting,
      primary: { provider: primaryProvider, model: primaryModel, health: primaryHealth },
      fallback: { provider: fallbackProvider, model: fallbackModel, health: fallbackHealth },
      visionFallbackDropped,
      attempts,
    };
  }
}

export default new ProviderModelResolver();
export { ProviderModelResolver };
