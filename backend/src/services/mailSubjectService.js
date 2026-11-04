/**
 * Where the ticket number sits in the subject of mail Ticket Pulse sends
 * (Vahid, 3 Nov 2026).
 *
 * Outlook groups a conversation by its subject (after RE:/FW:). Replies said
 * "Re: Laptop broken [TP-11013]" while workflow mail said "Ticket received:
 * TP-11013", so one ticket split into several conversations, and a long
 * subject hid the number at the end. A workspace can now put the number in
 * front: replies "Re: [TP-11013] Laptop broken", approval mail the same, and
 * workflows use {{ ticket.mailSubject }} ("[TP-11013] Laptop broken") so
 * every mail on the ticket shares one subject.
 *
 * Storage: `app_settings` key `mail_subject_ws<N>` (JSON, no migration).
 * Default "after" keeps today's subjects exactly. Reads fail to "after".
 * Inbound mail finds the number anywhere in the subject, so either position
 * threads back to the ticket.
 */
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

export const REF_POSITIONS = ['after', 'before'];
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { at, value }

export function mailSubjectKey(workspaceId) {
  return `mail_subject_ws${Number(workspaceId) || 0}`;
}

export function normalizeMailSubjectSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { refPosition: REF_POSITIONS.includes(src.refPosition) ? src.refPosition : 'after' };
}

export async function getMailSubjectSettings(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return normalizeMailSubjectSettings(null);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = normalizeMailSubjectSettings(null);
  try {
    const stored = await settingsRepository.get(mailSubjectKey(id));
    if (stored) value = normalizeMailSubjectSettings(typeof stored === 'string' ? JSON.parse(stored) : stored);
  } catch (err) {
    logger.warn(`mailSubject: settings read failed for workspace ${id} (number stays after the subject): ${err.message}`);
  }
  cache.set(id, { at: Date.now(), value });
  return value;
}

/** The position alone, for callers that only build a subject. Never throws. */
export async function refPositionFor(workspaceId) {
  return (await getMailSubjectSettings(workspaceId).catch(() => null))?.refPosition || 'after';
}

export async function setMailSubjectSettings(workspaceId, patch = {}) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  const next = normalizeMailSubjectSettings({ ...(await getMailSubjectSettings(id)), ...patch });
  await settingsRepository.set(mailSubjectKey(id), JSON.stringify(next));
  cache.delete(id);
  return next;
}

export function clearMailSubjectCache() {
  cache.clear();
}

const clean = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREFIX_RE = /^((?:(?:re|fw|fwd)\s*:\s*)+)/i;

/**
 * The ticket's own subject with its number, no "Re:": "[TP-11013] Laptop
 * broken" (before) or "Laptop broken [TP-11013]" (after). Before also drops
 * a leading RE:/FW: and a number already in the text, so the subject is the
 * same on every mail.
 */
export function ticketMailSubject(subject, ref, position = 'after') {
  const token = ref ? `[${ref}]` : '';
  let text = clean(subject);
  if (position === 'before') {
    if (token) text = clean(text.replace(new RegExp(`\\s*${escapeRe(token)}\\s*`, 'g'), ' '));
    text = text.replace(PREFIX_RE, '').trim();
    return clean(`${token} ${text || 'Your ticket'}`);
  }
  return clean(`${text || 'Your ticket'} ${token}`);
}

/**
 * The subject of a reply: "Re: " + the ticket's mail subject, or the agent's
 * own subject with the number added (in front of the text, after any RE:,
 * when the number goes first). A subject that already has the number is kept.
 */
export function replyMailSubject(subject, ref, position = 'after', override = null) {
  const token = ref ? `[${ref}]` : '';
  const own = clean(override);
  if (!own) return `Re: ${ticketMailSubject(subject, ref, position)}`;
  if (!token || own.includes(token)) return own;
  if (position === 'before') {
    const prefix = own.match(PREFIX_RE)?.[1] || '';
    return clean(`${prefix}${token} ${own.slice(prefix.length)}`);
  }
  return `${own} ${token}`;
}
