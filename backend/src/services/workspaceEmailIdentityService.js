import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { sanitizeFromName } from '../utils/emailSender.js';

/**
 * Per-workspace outbound sender identity (Phase EB).
 *
 * Resolution chain for the From display name:
 *   workspace_email_identities.from_name
 *   ?? global app_settings.sendgrid_from_name (env SENDGRID_FROM_NAME)
 *   ?? 'Ticket Pulse'
 *
 * The resolved name is GUARANTEED on the SendGrid path only. Microsoft
 * Graph sends as the connected mailbox and Exchange typically rewrites
 * arbitrary from-names to the directory displayName — graphMailClient
 * still sets it best-effort, but the durable Graph fix is renaming the
 * mailbox in Entra.
 */

const CACHE_TTL_MS = 60 * 1000;
const GLOBAL_CACHE_KEY = 'global';
const HARD_DEFAULT_FROM_NAME = 'Ticket Pulse';

// key (workspaceId number or 'global') -> { value, expiresAt }
const resolvedNameCache = new Map();

function cacheGet(key) {
  const entry = resolvedNameCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    resolvedNameCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  resolvedNameCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function normalizeWorkspaceId(workspaceId) {
  const id = Number(workspaceId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Drop all cached resolutions (call after any identity or global change). */
export function clearSenderIdentityCache() {
  resolvedNameCache.clear();
}

async function getGlobalFromName() {
  const config = await settingsRepository.getSendGridConfig();
  return sanitizeFromName(config.fromName) || HARD_DEFAULT_FROM_NAME;
}

/**
 * Resolve the effective From display name for a workspace (or the global
 * default when workspaceId is null — sync-health and other cross-workspace
 * sends). Cached for 60s; never throws.
 *
 * @param {number|null} workspaceId
 * @returns {Promise<string>}
 */
export async function resolveFromName(workspaceId = null) {
  const id = normalizeWorkspaceId(workspaceId);
  const key = id ?? GLOBAL_CACHE_KEY;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  let resolved = null;
  try {
    if (id !== null) {
      const row = await prisma.workspaceEmailIdentity.findUnique({
        where: { workspaceId: id },
        select: { fromName: true },
      });
      resolved = sanitizeFromName(row?.fromName);
    }
    if (!resolved) resolved = await getGlobalFromName();
  } catch (error) {
    logger.warn(`Sender identity resolution failed (using default): ${error.message}`);
    resolved = HARD_DEFAULT_FROM_NAME;
  }
  cacheSet(key, resolved);
  return resolved;
}

/**
 * Full identity view for the Settings UI: the workspace override (null =
 * inherit), the inherited global default, the effective name, and the
 * addresses the name will ride on.
 */
export async function getSenderIdentity(workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  const [row, sendgridConfig, mailboxConnection] = await Promise.all([
    id !== null
      ? prisma.workspaceEmailIdentity.findUnique({ where: { workspaceId: id } })
      : Promise.resolve(null),
    settingsRepository.getSendGridConfig(),
    id !== null
      ? prisma.mailboxConnection.findFirst({
        where: { workspaceId: id, isEnabled: true, mode: { in: ['send', 'both'] } },
        orderBy: { id: 'asc' },
        select: { address: true },
      })
      : Promise.resolve(null),
  ]);

  const overrideFromName = sanitizeFromName(row?.fromName);
  const globalFromName = sanitizeFromName(sendgridConfig.fromName) || HARD_DEFAULT_FROM_NAME;
  return {
    workspaceId: id,
    fromName: overrideFromName,
    globalFromName,
    effectiveFromName: overrideFromName || globalFromName,
    fromEmail: sendgridConfig.fromEmail || sendgridConfig.smtpFromEmail || null,
    mailboxAddress: mailboxConnection?.address || null,
    updatedBy: row?.updatedBy || null,
    updatedAt: row?.updatedAt || null,
  };
}

/**
 * Upsert the workspace override. A blank/whitespace fromName clears the
 * override back to "inherit global". Returns the fresh identity view.
 */
export async function upsertSenderIdentity(workspaceId, { fromName } = {}, actor = null) {
  const id = normalizeWorkspaceId(workspaceId);
  if (id === null) throw new Error('workspaceId is required');
  const cleaned = sanitizeFromName(fromName);
  const updatedBy = actor?.email || actor?.name || null;

  await prisma.workspaceEmailIdentity.upsert({
    where: { workspaceId: id },
    update: { fromName: cleaned, updatedBy },
    create: { workspaceId: id, fromName: cleaned, updatedBy },
  });
  clearSenderIdentityCache();
  return getSenderIdentity(id);
}

export default {
  resolveFromName,
  getSenderIdentity,
  upsertSenderIdentity,
  clearSenderIdentityCache,
};
