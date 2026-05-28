import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

class WorkspaceWebhookRepository {
  async getByWorkspaceId(workspaceId) {
    try {
      return await prisma.workspaceWebhookConfig.findUnique({
        where: { workspaceId },
      });
    } catch (error) {
      logger.error('Error fetching workspace webhook config', { workspaceId, error: error.message });
      throw new DatabaseError('Failed to fetch workspace webhook config', error);
    }
  }

  async ensureForWorkspace(workspaceId) {
    try {
      return await prisma.workspaceWebhookConfig.upsert({
        where: { workspaceId },
        update: {},
        create: { workspaceId },
      });
    } catch (error) {
      logger.error('Error ensuring workspace webhook config', { workspaceId, error: error.message });
      throw new DatabaseError('Failed to ensure workspace webhook config', error);
    }
  }

  async update(workspaceId, data) {
    try {
      return await prisma.workspaceWebhookConfig.update({
        where: { workspaceId },
        data,
      });
    } catch (error) {
      logger.error('Error updating workspace webhook config', { workspaceId, error: error.message });
      throw new DatabaseError('Failed to update workspace webhook config', error);
    }
  }

  async incrementReceipt(workspaceId) {
    try {
      return await prisma.workspaceWebhookConfig.update({
        where: { workspaceId },
        data: {
          lastReceivedAt: new Date(),
          receivedCount: { increment: 1 },
        },
      });
    } catch (error) {
      logger.warn('Failed to record webhook receipt', { workspaceId, error: error.message });
      return null;
    }
  }

  async recordAccepted(workspaceId) {
    try {
      return await prisma.workspaceWebhookConfig.update({
        where: { workspaceId },
        data: {
          lastAcceptedAt: new Date(),
          acceptedCount: { increment: 1 },
          lastErrorMessage: null,
        },
      });
    } catch (error) {
      logger.warn('Failed to record webhook acceptance', { workspaceId, error: error.message });
      return null;
    }
  }

  async recordRejected(workspaceId, reason = null) {
    try {
      return await prisma.workspaceWebhookConfig.update({
        where: { workspaceId },
        data: {
          lastRejectedAt: new Date(),
          rejectedCount: { increment: 1 },
          lastErrorMessage: reason ? String(reason).slice(0, 1000) : undefined,
        },
      });
    } catch (error) {
      logger.warn('Failed to record webhook rejection', { workspaceId, error: error.message });
      return null;
    }
  }

  async recordError(workspaceId, message) {
    try {
      return await prisma.workspaceWebhookConfig.update({
        where: { workspaceId },
        data: {
          lastErrorAt: new Date(),
          errorCount: { increment: 1 },
          lastErrorMessage: message ? String(message).slice(0, 1000) : 'Webhook processing failed',
        },
      });
    } catch (error) {
      logger.warn('Failed to record webhook error', { workspaceId, error: error.message });
      return null;
    }
  }
}

export default new WorkspaceWebhookRepository();
