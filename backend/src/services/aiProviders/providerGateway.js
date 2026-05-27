import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { classifyProviderError, sanitizeProviderErrorMessage } from './errorClassification.js';
import providerHealthService from './providerHealthService.js';
import providerModelResolver from './providerModelResolver.js';
import anthropicProvider from './anthropicProvider.js';
import openAiProvider from './openAiProvider.js';

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openAiProvider,
};

function providerClient(provider) {
  const client = PROVIDERS[provider];
  if (!client) throw new Error(`Unsupported AI provider: ${provider}`);
  return client;
}

function attemptUpdateData({ status, usage = null, error = null, durationMs = null, metadata = null }) {
  const classified = error ? classifyProviderError(error) : null;
  return {
    status,
    completedAt: new Date(),
    durationMs,
    inputTokens: usage?.inputTokens || null,
    outputTokens: usage?.outputTokens || null,
    errorClass: classified?.errorClass || null,
    errorMessage: error ? sanitizeProviderErrorMessage(error) : null,
    rawMetadata: metadata || null,
  };
}

class ProviderGateway {
  async runToolTurn(options) {
    return this._runWithFailover({
      ...options,
      call: (provider, callOptions) => providerClient(provider).toolResponse(callOptions),
    });
  }

  async sendJson(options) {
    return this._runWithFailover({
      ...options,
      call: (provider, callOptions) => providerClient(provider).sendJson(callOptions),
    });
  }

  async _runWithFailover({
    operation,
    workspaceId,
    legacyModel = null,
    runLinks = {},
    emit = null,
    call,
    ...callOptions
  }) {
    const resolution = await providerModelResolver.resolveAttempts({
      workspaceId,
      operation,
      legacyModel,
      preferredModel: callOptions.model,
      preferredProvider: callOptions.provider,
    });
    let lastError = null;
    let attemptNumber = 0;

    for (const attempt of resolution.attempts) {
      attemptNumber += 1;
      const startedAt = Date.now();
      const isFallback = !!attempt.fallbackFromProvider;
      emit?.({
        type: isFallback ? 'provider_fallback_started' : 'provider_attempt_started',
        provider: attempt.provider,
        model: attempt.model,
        attemptNumber,
        fallbackFromProvider: attempt.fallbackFromProvider,
        reason: attempt.fallbackReason,
      });

      const attemptRow = await prisma.aiProviderAttempt.create({
        data: {
          workspaceId,
          operation,
          provider: attempt.provider,
          model: attempt.model,
          attemptNumber,
          status: 'running',
          fallbackFromProvider: attempt.fallbackFromProvider || null,
          fallbackReason: attempt.fallbackReason || null,
          ...runLinks,
        },
      });

      try {
        const result = await call(attempt.provider, {
          ...callOptions,
          model: attempt.model,
          provider: attempt.provider,
        });
        const durationMs = Date.now() - startedAt;
        await prisma.aiProviderAttempt.update({
          where: { id: attemptRow.id },
          data: attemptUpdateData({
            status: 'succeeded',
            usage: result.usage,
            durationMs,
            metadata: result.metadata || null,
          }),
        });
        await providerHealthService.recordSuccess({
          workspaceId,
          operation,
          provider: attempt.provider,
          model: attempt.model,
          durationMs,
        });
        emit?.({
          type: 'provider_health',
          provider: attempt.provider,
          model: attempt.model,
          status: 'succeeded',
          attemptNumber,
        });
        return {
          ...result,
          provider: attempt.provider,
          model: attempt.model,
          attemptNumber,
          fallbackUsed: isFallback,
          fallbackFromProvider: attempt.fallbackFromProvider || null,
          fallbackReason: attempt.fallbackReason || null,
          resolution,
        };
      } catch (error) {
        lastError = error;
        const durationMs = Date.now() - startedAt;
        const classified = classifyProviderError(error);
        await prisma.aiProviderAttempt.update({
          where: { id: attemptRow.id },
          data: attemptUpdateData({
            status: 'failed',
            error,
            durationMs,
          }),
        });
        await providerHealthService.recordFailure({
          workspaceId,
          operation,
          provider: attempt.provider,
          model: attempt.model,
          error,
          durationMs,
        });
        emit?.({
          type: 'provider_attempt_failed',
          provider: attempt.provider,
          model: attempt.model,
          attemptNumber,
          errorClass: classified.errorClass,
          message: classified.message,
          retryable: classified.retryable,
        });
        logger.warn('AI provider attempt failed', {
          workspaceId,
          operation,
          provider: attempt.provider,
          model: attempt.model,
          attemptNumber,
          errorClass: classified.errorClass,
          retryable: classified.retryable,
          error: classified.message,
        });

        if (!classified.retryable) break;
      }
    }

    throw lastError || new Error('AI provider attempt failed');
  }

  isConfigured(provider) {
    return providerClient(provider).isConfigured();
  }
}

export default new ProviderGateway();
export { ProviderGateway };
