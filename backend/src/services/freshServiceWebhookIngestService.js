import { createFreshServiceClient } from '../integrations/freshservice.js';
import logger from '../utils/logger.js';
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

    let fsTicket;
    try {
      const fsConfig = await settingsRepository.getFreshServiceConfigForWorkspace(workspace.id);
      const client = createFreshServiceClient(fsConfig.domain, fsConfig.apiKey, {
        priority: 'high',
        source: 'freshservice-webhook',
      });
      fsTicket = await client.fetchTicketSnapshot(freshserviceTicketId);

      const actualWorkspaceId = getFreshServiceWorkspaceId(fsTicket);
      if (!sameFreshServiceWorkspace(workspace.freshserviceWorkspaceId, actualWorkspaceId)) {
        await workspaceWebhookService.recordRejected(workspace.id, 'workspace_mismatch');
        throw new WebhookIngestError('workspace_mismatch', 'FreshService ticket belongs to a different workspace', 403, {
          workspaceId: workspace.id,
          freshserviceTicketId,
          expectedFreshserviceWorkspaceId: workspace.freshserviceWorkspaceId?.toString?.() || workspace.freshserviceWorkspaceId,
          actualFreshserviceWorkspaceId: actualWorkspaceId ? String(actualWorkspaceId) : null,
        });
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
    } catch (error) {
      if (error instanceof WebhookIngestError) {
        throw error;
      }
      const status = safeFreshServiceStatus(error);
      const code = status ? `freshservice_${status}` : 'webhook_ingest_failed';
      const message = status
        ? `FreshService ticket fetch failed with HTTP ${status}`
        : (error.message || 'FreshService webhook ingest failed');
      await workspaceWebhookService.recordError(workspace.id, message);
      logger.warn('FreshService webhook ingest failed', {
        workspaceId: workspace.id,
        freshserviceTicketId: String(freshserviceTicketId),
        status,
        error: error.message,
      });
      throw new WebhookIngestError(code, message, status === 404 ? 404 : 502, {
        workspaceId: workspace.id,
        freshserviceTicketId: String(freshserviceTicketId),
        freshserviceStatus: status,
      });
    }
  }
}

export default new FreshServiceWebhookIngestService();
