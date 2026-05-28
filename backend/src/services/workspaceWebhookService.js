import crypto from 'crypto';
import bcrypt from 'bcrypt';
import workspaceWebhookRepository from './workspaceWebhookRepository.js';

const SECRET_PREFIX = 'tpwh';
const SECRET_BYTES = 32;
const BCRYPT_ROUNDS = 12;

function generateSecret() {
  return `${SECRET_PREFIX}_${crypto.randomBytes(SECRET_BYTES).toString('base64url')}`;
}

function secretSuffix(secret) {
  return String(secret || '').slice(-4);
}

function normalizeConfig(config, extras = {}) {
  if (!config) return null;
  return {
    id: config.id,
    workspaceId: config.workspaceId,
    enabled: config.enabled,
    hasSecret: Boolean(config.secretHash),
    secretLast4: config.secretLast4 || null,
    lastReceivedAt: config.lastReceivedAt || null,
    lastAcceptedAt: config.lastAcceptedAt || null,
    lastRejectedAt: config.lastRejectedAt || null,
    lastErrorAt: config.lastErrorAt || null,
    lastErrorMessage: config.lastErrorMessage || null,
    receivedCount: config.receivedCount || 0,
    acceptedCount: config.acceptedCount || 0,
    rejectedCount: config.rejectedCount || 0,
    errorCount: config.errorCount || 0,
    createdAt: config.createdAt || null,
    updatedAt: config.updatedAt || null,
    ...extras,
  };
}

class WorkspaceWebhookService {
  get headerName() {
    return 'X-Ticket-Pulse-Webhook-Secret';
  }

  generateSecret() {
    return generateSecret();
  }

  async getConfig(workspaceId, extras = {}) {
    const config = await workspaceWebhookRepository.ensureForWorkspace(workspaceId);
    return normalizeConfig(config, extras);
  }

  async getStoredConfig(workspaceId) {
    return workspaceWebhookRepository.getByWorkspaceId(workspaceId);
  }

  async updateConfig(workspaceId, data = {}, extras = {}) {
    await workspaceWebhookRepository.ensureForWorkspace(workspaceId);

    const update = {};
    let rawSecret = null;
    if (data.enabled !== undefined) {
      update.enabled = Boolean(data.enabled);
    }

    const existing = await workspaceWebhookRepository.getByWorkspaceId(workspaceId);
    if (update.enabled && !existing?.secretHash) {
      rawSecret = generateSecret();
      update.secretHash = await bcrypt.hash(rawSecret, BCRYPT_ROUNDS);
      update.secretLast4 = secretSuffix(rawSecret);
    }

    const updated = await workspaceWebhookRepository.update(workspaceId, update);
    return {
      ...normalizeConfig(updated, extras),
      secret: rawSecret,
    };
  }

  async rotateSecret(workspaceId, extras = {}) {
    await workspaceWebhookRepository.ensureForWorkspace(workspaceId);
    const rawSecret = generateSecret();
    const updated = await workspaceWebhookRepository.update(workspaceId, {
      secretHash: await bcrypt.hash(rawSecret, BCRYPT_ROUNDS),
      secretLast4: secretSuffix(rawSecret),
    });
    return {
      ...normalizeConfig(updated, extras),
      secret: rawSecret,
    };
  }

  async verifySecret(config, suppliedSecret) {
    if (!config?.secretHash || !suppliedSecret) return false;
    try {
      return await bcrypt.compare(String(suppliedSecret), config.secretHash);
    } catch {
      return false;
    }
  }

  async recordReceived(workspaceId) {
    return workspaceWebhookRepository.incrementReceipt(workspaceId);
  }

  async recordAccepted(workspaceId) {
    return workspaceWebhookRepository.recordAccepted(workspaceId);
  }

  async recordRejected(workspaceId, reason) {
    return workspaceWebhookRepository.recordRejected(workspaceId, reason);
  }

  async recordError(workspaceId, message) {
    return workspaceWebhookRepository.recordError(workspaceId, message);
  }

  buildWebhookUrl(baseUrl, workspaceSlug) {
    const root = String(baseUrl || '').replace(/\/+$/, '');
    return `${root}/api/freshservice-webhooks/${encodeURIComponent(workspaceSlug)}/tickets`;
  }
}

export default new WorkspaceWebhookService();
