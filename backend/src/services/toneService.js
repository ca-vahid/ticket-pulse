import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Tone of voice (QA 09-25 item 5).
 *
 * Mail Workflows' AI e-mails default to a warm, relaxed voice. Some people
 * would rather not be joked with, so each workspace keeps:
 *   - a default voice (friendly | professional). Professional is a floor: every
 *     AI e-mail in the workspace is written plainly, whatever the workflow says;
 *   - the "Straight-Talk List" — people who always get a professional reply;
 *   - the tone text appended to the AI's instructions when an override applies;
 *   - whether a frustrated requester (ticket sentiment) also switches the tone.
 *
 * Reads never throw: a missing table, a partial Prisma mock or a DB blip all
 * degrade to the defaults (friendly voice, nobody listed).
 */

export const TONE_VOICES = ['friendly', 'professional'];
export const DEFAULT_SERIOUS_TONE_TEXT = 'This person prefers a strictly professional tone. No jokes, emoji, puns, metaphors or playful phrasing. Be warm but plain and direct.';
export const OVERRIDE_REASONS = Object.freeze({
  list: 'straight_talk_list',
  frustrated: 'frustrated',
});

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 100;
// workspaceId -> { at, settings, emails:Set }
const cache = new Map();

const MAX_TEXT = 2000;
const MAX_NOTE = 500;

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function defaults(workspaceId) {
  return {
    workspaceId: Number(workspaceId) || null,
    defaultVoice: 'friendly',
    seriousToneText: DEFAULT_SERIOUS_TONE_TEXT,
    seriousToneTextIsDefault: true,
    seriousWhenFrustrated: true,
    updatedBy: null,
    updatedAt: null,
  };
}

function shapeSettings(workspaceId, row) {
  const base = defaults(workspaceId);
  if (!row) return base;
  const text = String(row.seriousToneText || '').trim();
  return {
    ...base,
    defaultVoice: TONE_VOICES.includes(row.defaultVoice) ? row.defaultVoice : 'friendly',
    seriousToneText: text || DEFAULT_SERIOUS_TONE_TEXT,
    seriousToneTextIsDefault: !text || text === DEFAULT_SERIOUS_TONE_TEXT,
    seriousWhenFrustrated: row.seriousWhenFrustrated !== false,
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt || null,
  };
}

function invalidate(workspaceId) {
  cache.delete(Number(workspaceId));
}

async function loadWorkspace(workspaceId) {
  const ws = Number(workspaceId);
  if (!ws) return { settings: defaults(null), emails: new Set() };
  const hit = cache.get(ws);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;

  const row = await Promise.resolve()
    .then(() => prisma.toneSettings.findUnique({ where: { workspaceId: ws } }))
    .catch((err) => {
      logger.debug?.(`Tone settings unavailable for ws ${ws} (defaults used): ${err.message}`);
      return null;
    });
  const contacts = await Promise.resolve()
    .then(() => prisma.toneOverrideContact.findMany({ where: { workspaceId: ws }, select: { email: true } }))
    .catch(() => []);
  const entry = {
    at: Date.now(),
    settings: shapeSettings(ws, row),
    emails: new Set((Array.isArray(contacts) ? contacts : []).map((c) => normalizeEmail(c.email)).filter(Boolean)),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ws, entry);
  return entry;
}

class ToneService {
  async getSettings(workspaceId) {
    return (await loadWorkspace(workspaceId)).settings;
  }

  async updateSettings(workspaceId, patch = {}, actorEmail = null) {
    const ws = Number(workspaceId);
    if (!ws) throw new Error('Workspace required');
    const data = {};
    if (patch.defaultVoice !== undefined) {
      if (!TONE_VOICES.includes(patch.defaultVoice)) throw new Error('Default voice must be friendly or professional');
      data.defaultVoice = patch.defaultVoice;
    }
    if (patch.seriousToneText !== undefined) {
      const text = String(patch.seriousToneText || '').trim();
      if (text.length > MAX_TEXT) throw new Error(`Tone text is limited to ${MAX_TEXT} characters`);
      // Blank or the default text = "use the default" (stored as null so a
      // future default wording change reaches this workspace too).
      data.seriousToneText = !text || text === DEFAULT_SERIOUS_TONE_TEXT ? null : text;
    }
    if (patch.seriousWhenFrustrated !== undefined) data.seriousWhenFrustrated = patch.seriousWhenFrustrated === true;
    data.updatedBy = actorEmail || null;
    const row = await prisma.toneSettings.upsert({
      where: { workspaceId: ws },
      create: { workspaceId: ws, ...data },
      update: data,
    });
    invalidate(ws);
    return shapeSettings(ws, row);
  }

  async listContacts(workspaceId) {
    const ws = Number(workspaceId);
    if (!ws) return [];
    const rows = await prisma.toneOverrideContact.findMany({
      where: { workspaceId: ws },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
    });
    return rows;
  }

  async addContact(workspaceId, { email, name = null, note = null } = {}, actorEmail = null) {
    const ws = Number(workspaceId);
    const normalized = normalizeEmail(email);
    if (!ws) throw new Error('Workspace required');
    if (!normalized) throw new Error('A valid e-mail address is required');
    const requester = await Promise.resolve()
      .then(() => prisma.requester.findFirst({
        where: { email: { equals: normalized, mode: 'insensitive' } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }))
      .catch(() => null);
    const cleanName = String(name || '').trim().slice(0, 255) || requester?.name || null;
    const cleanNote = String(note || '').trim().slice(0, MAX_NOTE) || null;
    const row = await prisma.toneOverrideContact.upsert({
      where: { workspaceId_email: { workspaceId: ws, email: normalized } },
      create: {
        workspaceId: ws,
        email: normalized,
        name: cleanName,
        requesterId: requester?.id || null,
        note: cleanNote,
        addedBy: actorEmail || null,
      },
      update: {
        name: cleanName,
        requesterId: requester?.id || null,
        ...(note !== undefined && note !== null ? { note: cleanNote } : {}),
      },
    });
    invalidate(ws);
    return row;
  }

  async removeContact(workspaceId, id) {
    const ws = Number(workspaceId);
    const contactId = Number(id);
    if (!ws || !contactId) throw new Error('Contact not found');
    const result = await prisma.toneOverrideContact.deleteMany({ where: { id: contactId, workspaceId: ws } });
    invalidate(ws);
    if (!result?.count) throw new Error('Contact not found');
    return { removed: result.count };
  }

  async isOnStraightTalkList(workspaceId, email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    try {
      return (await loadWorkspace(workspaceId)).emails.has(normalized);
    } catch {
      return false;
    }
  }

  /**
   * Which voice an AI e-mail to this requester should use.
   *   voice    — the workspace default voice (professional = floor)
   *   override — null, or {reason, text} when this person must get a
   *              professional reply (listed first, then frustration).
   * Never throws.
   */
  async resolveToneForTicket({ workspaceId, requesterEmail = null, sentiment = null } = {}) {
    let entry;
    try {
      entry = await loadWorkspace(workspaceId);
    } catch {
      entry = { settings: defaults(workspaceId), emails: new Set() };
    }
    const { settings, emails } = entry;
    const normalized = normalizeEmail(requesterEmail);
    let override = null;
    if (normalized && emails.has(normalized)) {
      override = { reason: OVERRIDE_REASONS.list, text: settings.seriousToneText };
    } else if (settings.seriousWhenFrustrated && String(sentiment || '').toLowerCase() === 'frustrated') {
      override = { reason: OVERRIDE_REASONS.frustrated, text: settings.seriousToneText };
    }
    return {
      voice: settings.defaultVoice,
      override,
      onStraightTalkList: Boolean(normalized && emails.has(normalized)),
    };
  }

  _clearCache() {
    cache.clear();
  }
}

const toneService = new ToneService();
export default toneService;
