import { createFreshServiceClient } from '../integrations/freshservice.js';
import logger from '../utils/logger.js';

// Retry schedule for the background ingest: a ticket FreshService has just
// created is not always readable on the first fetch (404), and the shared
// rate-limit queue can be busy. Three tries over ~30 s cover both.
export const INGEST_RETRY_DELAYS_MS = [3000, 8000, 20000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
import workspaceRepository from './workspaceRepository.js';
import settingsRepository from './settingsRepository.js';
import workspaceWebhookService from './workspaceWebhookService.js';
import syncService from './syncService.js';

export class WebhookIngestError extends Error {
  constructor(code, message, statusCode = 400, details = {}) {
    super(message);
    this.name = 'WebhookIngestError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function safeFreshServiceStatus(error) {
  return error?.response?.status
    || error?.originalError?.response?.status
    || error?.freshserviceStatus
    || null;
}

// The FS client wraps limiter rejections in plain Errors — match the preserved
// code OR the message (same predicate ticketService uses). A queue timeout
// means the request never launched: nothing reached FreshService.
function isFsQueueTimeout(error) {
  return error?.code === 'FS_QUEUE_TIMEOUT'
    || error?.originalError?.code === 'FS_QUEUE_TIMEOUT'
    || /rate-limit queue/.test(error?.message || '');
}

function getFreshServiceWorkspaceId(fsTicket) {
  return fsTicket?.workspace_id
    ?? fsTicket?.workspaceId
    ?? fsTicket?.workspace?.id
    ?? null;
}

function sameFreshServiceWorkspace(expected, actual) {
  if (expected === undefined || expected === null || expected === '') return true;
  if (actual === undefined || actual === null || actual === '') return false;
  try {
    return BigInt(expected).toString() === BigInt(actual).toString();
  } catch {
    return String(expected) === String(actual);
  }
}

class FreshServiceWebhookIngestService {
  async handleTicketWebhook({ workspaceSlug, freshserviceTicketId, suppliedSecret }) {
    if (!workspaceSlug) {
      throw new WebhookIngestError('missing_workspace', 'Workspace slug is required', 400);
    }
    if (!freshserviceTicketId) {
      throw new WebhookIngestError('missing_ticket_id', 'FreshService ticket ID is required', 400);
    }

    const workspace = await workspaceRepository.getBySlug(workspaceSlug);
    if (!workspace) {
      throw new WebhookIngestError('workspace_not_found', 'Workspace not found', 404);
    }
    if (!workspace.isActive) {
      throw new WebhookIngestError('workspace_inactive', 'Workspace is not active', 403, {
        workspaceId: workspace.id,
      });
    }

    const webhookConfig = await workspaceWebhookService.getStoredConfig(workspace.id);
    if (!webhookConfig) {
      throw new WebhookIngestError('webhook_not_configured', 'Webhook is not configured for this workspace', 403, {
        workspaceId: workspace.id,
      });
    }

    await workspaceWebhookService.recordReceived(workspace.id);

    if (!webhookConfig.enabled) {
      await workspaceWebhookService.recordRejected(workspace.id, 'webhook_disabled');
      throw new WebhookIngestError('webhook_disabled', 'Webhook is disabled for this workspace', 403, {
        workspaceId: workspace.id,
      });
    }

    const validSecret = await workspaceWebhookService.verifySecret(webhookConfig, suppliedSecret);
    if (!validSecret) {
      await workspaceWebhookService.recordRejected(workspace.id, 'invalid_secret');
      throw new WebhookIngestError('invalid_secret', 'Webhook secret is invalid', 401, {
        workspaceId: workspace.id,
      });
    }

    // Ack fast (Simorgh 13.1-2, 09-14). FreshService's automator gives a
    // webhook a few seconds; we used to fetch the ticket, sync it and kick the
    // assignment poll BEFORE answering, so the first firing on a fresh ticket
    // regularly exceeded that budget — FreshService logged "Result - Failed",
    // retried minutes later, and the retry succeeded. 8,393 received / 8,112
    // accepted said the work was fine; only the timing was wrong. Now the
    // request is validated and acknowledged, and the ingest runs behind it
    // with its own retry for a ticket FreshService has not finished indexing.
    const pending = this._ingestInBackground(workspace, freshserviceTicketId);
    return {
      accepted: true,
      queued: true,
      freshserviceTicketId: String(freshserviceTicketId),
      // Callers that need the outcome (tests, the sync-health probe) await this;
      // the HTTP route drops it from the JSON.
      pending,
    };
  }

  /** Background ingest with retry. Never throws — it records instead. */
  async _ingestInBackground(workspace, freshserviceTicketId) {
    const delays = INGEST_RETRY_DELAYS_MS;
    let attempt = 0;
    for (;;) {
      try {
        return await this._ingestOnce(workspace, freshserviceTicketId);
      } catch (error) {
        const status = safeFreshServiceStatus(error);
        const retryable = status === 404 || isFsQueueTimeout(error);
        if (!retryable || attempt >= delays.length) {
          const message = isFsQueueTimeout(error)
            ? 'FreshService rate-limit queue timed out'
            : status ? `FreshService ticket fetch failed with HTTP ${status}` : (error.message || 'FreshService webhook ingest failed');
          await Promise.resolve(workspaceWebhookService.recordError(workspace.id, message)).catch(() => {});
          logger.warn('FreshService webhook ingest failed', {
            workspaceId: workspace.id, freshserviceTicketId: String(freshserviceTicketId), status, attempt, error: error.message,
          });
          return { accepted: true, synced: false, error: message, attempts: attempt + 1 };
        }
        const wait = delays[attempt];
        attempt += 1;
        logger.info('FreshService webhook ingest retry scheduled', {
          workspaceId: workspace.id, freshserviceTicketId: String(freshserviceTicketId), attempt, waitMs: wait,
          reason: status === 404 ? 'ticket_not_yet_readable' : 'queue_timeout',
        });
        await sleep(wait);
      }
    }
  }

  /** One ingest attempt: fetch, workspace check, sync, assignment poll. */
  async _ingestOnce(workspace, freshserviceTicketId) {
    const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspace.id);
    const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
      priority: 'high',
      source: 'freshservice-webhook',
      // A bounded queue wait: congestion becomes a retry, not a hang.
      queueTimeoutMs: 15000,
    });
    const fsTicket = await client.fetchTicketSnapshot(freshserviceTicketId);

    const actualWorkspaceId = getFreshServiceWorkspaceId(fsTicket);
    if (!sameFreshServiceWorkspace(workspace.freshserviceWorkspaceId, actualWorkspaceId)) {
      await workspaceWebhookService.recordRejected(workspace.id, 'workspace_mismatch');
      logger.warn('FreshService webhook rejected: workspace mismatch', {
        workspaceId: workspace.id, freshserviceTicketId: String(freshserviceTicketId),
        expected: workspace.freshserviceWorkspaceId?.toString?.() || workspace.freshserviceWorkspaceId,
        actual: actualWorkspaceId ? String(actualWorkspaceId) : null,
      });
      return { accepted: true, synced: false, rejected: 'workspace_mismatch' };
    }

    const syncResult = await syncService.syncFreshServiceTicketSnapshot(workspace.id, fsTicket, {
      client,
      source: 'freshservice_webhook',
      clearReadCache: true,
      waitForNoiseSync: true,
      assignmentChangeNotificationSource: 'freshservice_webhook_assignment_change',
      initialAssignmentNotificationSource: 'freshservice_webhook_initial_assignment',
      allowNotificationWorkflows: true,
    });

    const polling = await syncService._pollForUnassignedTickets(workspace.id, {
      ticketIdsOverride: [syncResult.ticket.id],
      maxPerCycleOverride: 1,
      waitForCompletion: false,
      settleAfterMs: 1000,
      triggerSourceOverride: 'webhook',
    });

    await workspaceWebhookService.recordAccepted(workspace.id);

    const result = {
      accepted: true,
      freshserviceTicketId: String(freshserviceTicketId),
      ticketId: syncResult.ticket.id,
      synced: true,
      assignmentTriggered: Number(polling?.triggered || 0) > 0,
      skippedReason: Number(polling?.triggered || 0) > 0
        ? null
        : (polling?.reason || (syncResult.ticket.assignedTechId ? 'already_assigned' : syncResult.ticket.isNoise ? 'noise_ticket' : 'no_assignment_candidate')),
      polling,
    };
    logger.info('FreshService webhook accepted', {
      workspaceId: workspace.id,
      freshserviceTicketId: String(freshserviceTicketId),
      ticketId: syncResult.ticket.id,
      assignmentTriggered: result.assignmentTriggered,
      skippedReason: result.skippedReason,
    });
    return result;
  }
}

export default new FreshServiceWebhookIngestService();
