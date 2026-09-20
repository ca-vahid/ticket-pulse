/**
 * Reply greeting + sign-off (QA 09-18 #4).
 *
 * FreshService opens every agent reply with "Hi <Requester>," — agents
 * missed that in Ticket Pulse. Per workspace an admin turns the greeting on
 * and edits the two lines; per agent a preference decides whether the lines
 * are added the moment a reply starts (`auto`) or only on demand (`manual`).
 *
 * Storage: `app_settings` key `reply_greeting_ws<N>` (JSON, no migration).
 * Cached briefly; reads fail closed (off) so a settings hiccup never changes
 * what a reply looks like.
 *
 * Placeholders (filled client-side at insert time and server-side wherever a
 * template is rendered): {{requester.firstName}} {{requester.name}}
 * {{agent.firstName}} {{agent.name}} {{ticket.ref}} {{ticket.subject}}.
 */
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { at, value }
const MAX_LINE = 400;

export const DEFAULT_GREETING = 'Hi {{requester.firstName}},';
export const DEFAULT_SIGNOFF = 'Thank you,\n{{agent.firstName}}';

export function replyGreetingKey(workspaceId) {
  return `reply_greeting_ws${Number(workspaceId) || 0}`;
}

export function normalizeGreetingSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const line = (v, fallback) => {
    if (v === undefined || v === null) return fallback;
    return String(v).replace(/\r\n/g, '\n').slice(0, MAX_LINE);
  };
  return {
    enabled: src.enabled === true,
    greeting: line(src.greeting, DEFAULT_GREETING),
    signoff: line(src.signoff, DEFAULT_SIGNOFF),
  };
}

export async function getReplyGreetingSettings(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return normalizeGreetingSettings(null);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = normalizeGreetingSettings(null);
  try {
    const stored = await settingsRepository.get(replyGreetingKey(id));
    if (stored) {
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      value = normalizeGreetingSettings(parsed);
    }
  } catch (err) {
    logger.warn(`replyGreeting: settings read failed for workspace ${id} (treating as off): ${err.message}`);
  }
  cache.set(id, { at: Date.now(), value });
  return value;
}

export async function setReplyGreetingSettings(workspaceId, patch = {}) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  const current = await getReplyGreetingSettings(id);
  const next = normalizeGreetingSettings({ ...current, ...patch });
  await settingsRepository.set(replyGreetingKey(id), JSON.stringify(next));
  cache.delete(id);
  return next;
}

export function clearReplyGreetingCache() {
  cache.clear();
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const nameFromEmail = (email) => String(email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/(^|\s)(\w)/g, (m, sp, c) => sp + c.toUpperCase());

/**
 * Fill the greeting placeholders. Unknown tokens are removed rather than
 * shipped literally ("Hi {{requester.firstName}}," in a customer's inbox).
 */
export function fillGreetingPlaceholders(text, { requester = null, agent = null, ticket = null } = {}) {
  const map = {
    'requester.firstName': firstName(requester?.name) || firstName(nameFromEmail(requester?.email)) || 'there',
    'requester.name': String(requester?.name || '').trim() || nameFromEmail(requester?.email) || 'there',
    'agent.firstName': firstName(agent?.name) || '',
    'agent.name': String(agent?.name || '').trim(),
    'ticket.ref': String(ticket?.displayRef || ticket?.ref || '').trim(),
    'ticket.subject': String(ticket?.subject || '').trim(),
  };
  return String(text || '').replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, key) => (key in map ? map[key] : ''));
}
