import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { setWorkspaceLinkNames } from '../utils/ticketLink.js';
import { RESERVED_WORKSPACE_SLUGS } from './ticketShortLinkService.js';

/**
 * A workspace's link name: the short first part of its ticket links
 * (ticketpulse.bgcsaas.com/it/TP-10000, /acct/TP-10001). Separate from the slug on
 * purpose: FreshService webhooks post to /api/freshservice-webhooks/<slug>/tickets, so
 * the slug must not change. Stored in app_settings (`workspace_link_name_ws<id>`); a
 * workspace without one uses its slug.
 */
const REFRESH_MS = 5 * 60 * 1000;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
let timer = null;

export const linkNameSettingKey = (workspaceId) => `workspace_link_name_ws${Number(workspaceId) || 0}`;

async function activeWorkspaces() {
  return Promise.resolve()
    .then(() => prisma.workspace.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true } }))
    .catch(() => []);
}

/** { workspaceId: linkName } for every active workspace (stored name, else slug). */
export async function getLinkNames(workspaces = null) {
  const list = workspaces || await activeWorkspaces();
  const out = {};
  await Promise.all(list.map(async (ws) => {
    const stored = await Promise.resolve().then(() => settingsRepository.get(linkNameSettingKey(ws.id))).catch(() => null);
    const name = String(stored || '').trim().toLowerCase();
    out[ws.id] = name || String(ws.slug || '').toLowerCase();
  }));
  return out;
}

/** Load the names into the in-memory map the e-mail link builder reads. Never throws. */
export async function refresh() {
  try {
    setWorkspaceLinkNames(await getLinkNames());
  } catch (err) {
    logger.warn(`Workspace link names not loaded (${err.message}); ticket links stay in the long form`);
  }
}

export function startRefresh() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
}

/** Why a link name cannot be used, or null. */
export async function validateLinkName(workspaceId, raw) {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return 'Use 1 to 30 lowercase letters, digits or dashes';
  if (RESERVED_WORKSPACE_SLUGS.includes(name)) return `"${name}" is the name of a page in Ticket Pulse`;
  if (/^(tp-?)?\d+$/.test(name)) return 'A link name cannot look like a ticket number';
  const workspaces = await activeWorkspaces();
  const names = await getLinkNames(workspaces);
  for (const ws of workspaces) {
    if (ws.id === Number(workspaceId)) continue;
    if (names[ws.id] === name || String(ws.slug).toLowerCase() === name) return `"${name}" is already used by ${ws.name}`;
  }
  return null;
}

export async function setLinkName(workspaceId, raw) {
  const error = await validateLinkName(workspaceId, raw);
  if (error) return { ok: false, error };
  const name = String(raw).trim().toLowerCase();
  await settingsRepository.set(linkNameSettingKey(workspaceId), name);
  await refresh();
  return { ok: true, linkName: name };
}

export default { getLinkNames, refresh, startRefresh, validateLinkName, setLinkName, linkNameSettingKey };
