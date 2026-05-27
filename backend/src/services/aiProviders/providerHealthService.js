import prisma from '../prisma.js';
import logger from '../../utils/logger.js';
import { classifyProviderError, sanitizeProviderErrorMessage } from './errorClassification.js';
import { AI_PROVIDERS, normalizeProvider } from '../../utils/aiProviders.js';

const ROLLING_WINDOW_MS = 5 * 60 * 1000;
const DWELL_MS = 2 * 60 * 1000;

function eventTime(event) {
  return event?.createdAt ? new Date(event.createdAt).getTime() : 0;
}

class ProviderHealthService {
  async recordSuccess({
    workspaceId = null,
    operation = null,
    provider,
    model = null,
    durationMs = null,
  }) {
    const normalizedProvider = normalizeProvider(provider);
    try {
      return await prisma.aiProviderHealthEvent.create({
        data: {
          workspaceId,
          operation,
          provider: normalizedProvider,
          model,
          success: true,
          durationMs,
        },
      });
    } catch (error) {
      logger.debug('Failed to record provider success health event', {
        provider: normalizedProvider,
        operation,
        error: error.message,
      });
      return null;
    }
  }

  async recordFailure({
    workspaceId = null,
    operation = null,
    provider,
    model = null,
    error,
    durationMs = null,
  }) {
    const normalizedProvider = normalizeProvider(provider);
    const classified = classifyProviderError(error);
    try {
      return await prisma.aiProviderHealthEvent.create({
        data: {
          workspaceId,
          operation,
          provider: normalizedProvider,
          model,
          success: false,
          errorClass: classified.errorClass,
          statusCode: classified.statusCode,
          durationMs,
          sanitizedMessage: sanitizeProviderErrorMessage(error),
        },
      });
    } catch (writeError) {
      logger.debug('Failed to record provider failure health event', {
        provider: normalizedProvider,
        operation,
        error: writeError.message,
      });
      return null;
    }
  }

  async getStatus(provider, operation = null, workspaceId = null) {
    const normalizedProvider = normalizeProvider(provider);
    const since = new Date(Date.now() - ROLLING_WINDOW_MS);
    const where = {
      provider: normalizedProvider,
      createdAt: { gte: since },
      ...(operation ? { operation } : {}),
      ...(workspaceId ? { OR: [{ workspaceId }, { workspaceId: null }] } : {}),
    };
    const events = await prisma.aiProviderHealthEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return this._classifyEvents(normalizedProvider, events);
  }

  async getStatuses({ workspaceId = null, operation = null } = {}) {
    const entries = await Promise.all(
      AI_PROVIDERS.map(async (provider) => [provider, await this.getStatus(provider, operation, workspaceId)]),
    );
    return Object.fromEntries(entries);
  }

  _classifyEvents(provider, events = []) {
    if (!events.length) {
      return {
        provider,
        status: 'unknown',
        routingEligible: true,
        successCount: 0,
        failureCount: 0,
        lastEventAt: null,
        lastErrorClass: null,
        dwellUntil: null,
      };
    }

    const successCount = events.filter((event) => event.success).length;
    const failureCount = events.length - successCount;
    const lastEvent = events[0];
    const lastSuccess = events.find((event) => event.success);
    const lastFailure = events.find((event) => !event.success);
    const latestSuccessAt = eventTime(lastSuccess);
    const latestFailureAt = eventTime(lastFailure);
    const failureStreak = events.findIndex((event) => event.success);
    const normalizedFailureStreak = failureStreak === -1 ? events.length : failureStreak;
    const hardDownFailure = lastFailure && ['config_missing', 'auth_error'].includes(lastFailure.errorClass);

    let status = 'healthy';
    let routingEligible = true;
    let dwellUntil = null;

    if (hardDownFailure && latestFailureAt >= latestSuccessAt) {
      status = 'down';
      routingEligible = false;
    } else if (normalizedFailureStreak >= 3) {
      status = 'down';
      routingEligible = false;
    } else if (failureCount > 0) {
      status = 'degraded';
    }

    if (latestFailureAt > 0 && latestSuccessAt > latestFailureAt) {
      const dwellEndsAt = latestSuccessAt + DWELL_MS;
      if (Date.now() < dwellEndsAt) {
        status = 'degraded';
        routingEligible = false;
        dwellUntil = new Date(dwellEndsAt).toISOString();
      }
    }

    return {
      provider,
      status,
      routingEligible,
      successCount,
      failureCount,
      lastEventAt: lastEvent.createdAt,
      lastErrorClass: lastFailure?.errorClass || null,
      lastMessage: lastFailure?.sanitizedMessage || null,
      dwellUntil,
    };
  }
}

export default new ProviderHealthService();
export { ProviderHealthService };
