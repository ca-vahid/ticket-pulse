/**
 * Knowledge → Settings → Prompts (30 Sep 2026). Auto-help's three prompts
 * each carry one editable block of guidance, versioned like the assignment
 * prompts (draft → published; the previous published one is archived;
 * restore copies an old version into a new draft):
 *
 *   answer  "Answer writing": voice and style of the requester answer
 *   route   "Playbook choice": how picky the choice of playbook is
 *   check   "Answer check": how strict the "is the knowledge enough?" check is
 *
 * The safety and format rules around each block are fixed in the runner and
 * shown read-only next to the editor — guidance can change tone and
 * judgement, never the data fencing, citation or tool rules.
 *
 * No published row = the built-in default. Reads fail soft to the default.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

export const PROMPT_KEYS = Object.freeze(['answer', 'route', 'check']);
export const MAX_GUIDANCE_CHARS = 4000;

export const PROMPT_DEFAULTS = Object.freeze({
  answer: 'Write for the requester: short, warm, plain words; no internal jargon.',
  route: [
    'Typos, synonyms, other languages and informal wording are fine - judge the meaning.',
    'Choose a playbook only when the ticket is clearly the kind of request it is for. When none fits, choose 0 - a person picks the ticket up.',
  ].join('\n'),
  check: 'Be strict.',
});

export const PROMPT_LABELS = Object.freeze({
  answer: { title: 'Answer writing', hint: 'Voice and style of the answer the requester gets.' },
  route: { title: 'Playbook choice', hint: 'How the AI decides which playbook (if any) answers a ticket.' },
  check: { title: 'Answer check', hint: 'How strict the check "does the knowledge really cover this?" is.' },
});

const CACHE_MS = 60 * 1000;
const cache = new Map(); // workspaceId -> { at, bodies, versions }

/** Test hook. */
export function _resetPromptCache() { cache.clear(); }

function cleanBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new ValidationError('Write some guidance first');
  if (text.length > MAX_GUIDANCE_CHARS) throw new ValidationError(`Guidance is limited to ${MAX_GUIDANCE_CHARS} characters`);
  return text;
}

function assertKey(key) {
  if (!PROMPT_KEYS.includes(key)) throw new ValidationError(`Prompt must be one of: ${PROMPT_KEYS.join(', ')}`);
}

function view(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.key, version: row.version, status: row.status, body: row.body,
    // The diff window reads `systemPrompt` (shared with the assignment prompts).
    systemPrompt: row.body,
    notes: row.notes || null, createdBy: row.createdBy || null, publishedBy: row.publishedBy || null,
    publishedAt: row.publishedAt || null, createdAt: row.createdAt,
  };
}

class AutoHelpPromptService {
  /**
   * The guidance a run uses: { answer, route, check } bodies and the version
   * each came from (null = built-in default). Cached a minute per workspace.
   */
  async getActive(workspaceId) {
    const ws = Number(workspaceId);
    const hit = cache.get(ws);
    if (hit && Date.now() - hit.at < CACHE_MS) return { bodies: hit.bodies, versions: hit.versions };
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpPromptVersion.findMany({ where: { workspaceId: ws, status: 'published' } }))
      .catch((err) => { logger.warn(`Auto-help prompts: read failed (ws ${ws}), using defaults: ${err.message}`); return []; });
    const bodies = { ...PROMPT_DEFAULTS };
    const versions = { answer: null, route: null, check: null };
    for (const r of rows || []) {
      if (!PROMPT_KEYS.includes(r.key) || !String(r.body || '').trim()) continue;
      bodies[r.key] = r.body;
      versions[r.key] = r.version;
    }
    cache.set(ws, { at: Date.now(), bodies, versions });
    return { bodies, versions };
  }

  /** Every key with its published version (or the default) and all versions, newest first. */
  async list(workspaceId) {
    const ws = Number(workspaceId);
    const rows = await Promise.resolve()
      .then(() => prisma.autoHelpPromptVersion.findMany({ where: { workspaceId: ws }, orderBy: [{ key: 'asc' }, { version: 'desc' }], take: 600 }))
      .catch(() => []);
    return PROMPT_KEYS.map((key) => {
      const versions = (rows || []).filter((r) => r.key === key).map(view);
      const published = versions.find((v) => v.status === 'published') || null;
      return {
        key,
        ...PROMPT_LABELS[key],
        defaultBody: PROMPT_DEFAULTS[key],
        activeBody: published?.body || PROMPT_DEFAULTS[key],
        published,
        versions,
      };
    });
  }

  async get(workspaceId, id) {
    const row = await prisma.autoHelpPromptVersion.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } });
    if (!row) throw new NotFoundError('Prompt version not found');
    return view(row);
  }

  async createDraft(workspaceId, { key, body, notes = null }, actor) {
    assertKey(key);
    const ws = Number(workspaceId);
    const text = cleanBody(body);
    const last = await prisma.autoHelpPromptVersion.findFirst({ where: { workspaceId: ws, key }, orderBy: { version: 'desc' }, select: { version: true } });
    const row = await prisma.autoHelpPromptVersion.create({
      data: {
        workspaceId: ws, key, version: (last?.version || 0) + 1, status: 'draft', body: text,
        notes: notes ? String(notes).trim().slice(0, 500) || null : null,
        createdBy: actor?.email || actor?.name || null,
      },
    });
    return view(row);
  }

  /** Publish a version; the key's previous published version is archived. */
  async publish(workspaceId, id, actor) {
    const ws = Number(workspaceId);
    const row = await prisma.autoHelpPromptVersion.findFirst({ where: { id: Number(id), workspaceId: ws } });
    if (!row) throw new NotFoundError('Prompt version not found');
    const [, published] = await prisma.$transaction([
      prisma.autoHelpPromptVersion.updateMany({ where: { workspaceId: ws, key: row.key, status: 'published', NOT: { id: row.id } }, data: { status: 'archived' } }),
      prisma.autoHelpPromptVersion.update({
        where: { id: row.id },
        data: { status: 'published', publishedBy: actor?.email || actor?.name || null, publishedAt: new Date() },
      }),
    ]);
    cache.delete(ws);
    logger.info(`Auto-help prompt "${row.key}" v${row.version} published in ws ${ws} by ${actor?.email || 'unknown'}`);
    return view(published);
  }

  /** Back to the built-in default: archive the published version of a key. */
  async useDefault(workspaceId, key) {
    assertKey(key);
    const ws = Number(workspaceId);
    await prisma.autoHelpPromptVersion.updateMany({ where: { workspaceId: ws, key, status: 'published' }, data: { status: 'archived' } });
    cache.delete(ws);
    return { key, body: PROMPT_DEFAULTS[key] };
  }

  /** Copy an old version into a new draft. */
  async restore(workspaceId, id, actor) {
    const src = await this.get(workspaceId, id);
    return this.createDraft(workspaceId, { key: src.key, body: src.body, notes: `Restored from v${src.version}` }, actor);
  }

  async remove(workspaceId, id) {
    const row = await this.get(workspaceId, id);
    if (row.status === 'published') throw new ValidationError('The published version cannot be deleted — publish another one (or use the default) first');
    await prisma.autoHelpPromptVersion.delete({ where: { id: row.id } });
    return { deleted: true };
  }
}

const autoHelpPromptService = new AutoHelpPromptService();
export default autoHelpPromptService;
