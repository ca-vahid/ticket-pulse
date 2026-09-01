import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { sanitizeFromName } from '../utils/emailSender.js';
import { pickOutboundMailbox } from './mailboxPicker.js';

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
 *
 * Requester REPLIES (Mega 08-30 Phase SN, QA 08-28 #2) go out under the
 * replying agent's own name — "Susan Xu <ticketpulse@…>" — exactly like
 * FreshService does, via `resolveReplyFromName`. Per-workspace toggle
 * `reply_uses_agent_name` (default ON) falls back to the chain above.
 * Approvals, workflows and sync-health mails keep the workspace identity.
 */

const CACHE_TTL_MS = 60 * 1000;
const GLOBAL_CACHE_KEY = 'global';
const HARD_DEFAULT_FROM_NAME = 'Ticket Pulse';
const REPLY_AGENT_NAME_DEFAULT = true;

// key (workspaceId number, 'global', or 'reply-agent:<id>') -> { value, expiresAt }
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
 * Is "replies show the agent's name" on for this workspace? No row = the
 * documented default (ON). Cached 60s; a read failure resolves to the
 * default too (the toggle is cosmetic — it must never block a send).
 */
export async function isReplyAgentNameEnabled(workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  if (id === null) return REPLY_AGENT_NAME_DEFAULT;
  const key = `reply-agent:${id}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  let enabled = REPLY_AGENT_NAME_DEFAULT;
  try {
    const row = await prisma.workspaceEmailIdentity.findUnique({
      where: { workspaceId: id },
      select: { replyUsesAgentName: true },
    });
    if (row && typeof row.replyUsesAgentName === 'boolean') enabled = row.replyUsesAgentName;
  } catch (error) {
    logger.warn(`Reply agent-name toggle read failed (using default): ${error.message}`);
    enabled = REPLY_AGENT_NAME_DEFAULT;
  }
  cacheSet(key, enabled);
  return enabled;
}

/**
 * A bare email address is not a display name — "coord@example.com
 * <ticketpulse@…>" reads as a spoof. Names that are just an address fall
 * back to the workspace identity.
 */
function usableActorName(actorName) {
  const cleaned = sanitizeFromName(actorName);
  if (!cleaned) return null;
  if (/^[^\s@]+@[^\s@]+$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * From display name for a REQUESTER REPLY sent by an agent (Phase SN1):
 * the agent's own (sanitized) name when the workspace toggle is on and a
 * usable name exists; otherwise the workspace identity. Scoped to replies —
 * approvals / workflows / sync-health keep calling resolveFromName.
 *
 * @param {number|null} workspaceId
 * @param {string|null|undefined} actorName the entry's actorName
 * @returns {Promise<string>}
 */
export async function resolveReplyFromName(workspaceId = null, actorName = null) {
  const agentName = usableActorName(actorName);
  if (agentName && await isReplyAgentNameEnabled(workspaceId)) return agentName;
  return resolveFromName(workspaceId);
}

/**
 * Full identity view for the Settings UI: the workspace override (null =
 * inherit), the inherited global default, the effective name, the reply
 * agent-name toggle, and the addresses the name will ride on.
 */
export async function getSenderIdentity(workspaceId) {
  const id = normalizeWorkspaceId(workspaceId);
  const [row, sendgridConfig, mailboxConnection] = await Promise.all([
    id !== null
      ? prisma.workspaceEmailIdentity.findUnique({ where: { workspaceId: id } })
      : Promise.resolve(null),
    settingsRepository.getSendGridConfig(),
    // Same picker every outbound lane uses (MB-1g), so the Settings view
    // names the address mail will actually leave from.
    id !== null ? pickOutboundMailbox(id) : Promise.resolve(null),
  ]);

  const overrideFromName = sanitizeFromName(row?.fromName);
  const globalFromName = sanitizeFromName(sendgridConfig.fromName) || HARD_DEFAULT_FROM_NAME;
  return {
    workspaceId: id,
    fromName: overrideFromName,
    globalFromName,
    effectiveFromName: overrideFromName || globalFromName,
    replyUsesAgentName: typeof row?.replyUsesAgentName === 'boolean' ? row.replyUsesAgentName : REPLY_AGENT_NAME_DEFAULT,
    fromEmail: sendgridConfig.fromEmail || sendgridConfig.smtpFromEmail || null,
    mailboxAddress: mailboxConnection?.address || null,
    updatedBy: row?.updatedBy || null,
    updatedAt: row?.updatedAt || null,
  };
}

/**
 * Upsert the workspace override. A blank/whitespace fromName clears the
 * override back to "inherit global"; an undefined fromName leaves it alone
 * (toggle-only saves). `replyUsesAgentName` is applied only when a boolean
 * is passed. Returns the fresh identity view.
 */
export async function upsertSenderIdentity(workspaceId, { fromName, replyUsesAgentName } = {}, actor = null) {
  const id = normalizeWorkspaceId(workspaceId);
  if (id === null) throw new Error('workspaceId is required');
  const updatedBy = actor?.email || actor?.name || null;

  const patch = { updatedBy };
  if (fromName !== undefined) patch.fromName = sanitizeFromName(fromName);
  if (typeof replyUsesAgentName === 'boolean') patch.replyUsesAgentName = replyUsesAgentName;

  await prisma.workspaceEmailIdentity.upsert({
    where: { workspaceId: id },
    update: patch,
    create: {
      workspaceId: id,
      fromName: fromName !== undefined ? sanitizeFromName(fromName) : null,
      ...(typeof replyUsesAgentName === 'boolean' ? { replyUsesAgentName } : {}),
      updatedBy,
    },
  });
  clearSenderIdentityCache();
  return getSenderIdentity(id);
}

export default {
  resolveFromName,
  resolveReplyFromName,
  isReplyAgentNameEnabled,
  getSenderIdentity,
  upsertSenderIdentity,
  clearSenderIdentityCache,
};
