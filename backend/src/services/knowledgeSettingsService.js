/**
 * Per-workspace Knowledge switches (Auto-help P1): the weekly "review due"
 * digest (off by default) and contribution by skill. A missing table
 * (migration not applied yet) reads as the defaults and refuses writes with
 * a clear message instead of a 500.
 *
 * The FreshService solution-article import was removed on 26 Oct 2026
 * (QA 10-26 #7). Its columns (fs_import_enabled, fs_folder_ids,
 * fs_import_state, fs_imported_at) stay in the table, unread and unwritten.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

export const DEFAULT_KNOWLEDGE_SETTINGS = Object.freeze({
  reviewDigestEnabled: false,
  reviewDigestSentAt: null,
});

/** The skill levels a workspace can require for writing and for checking. */
export const CONTRIBUTION_LEVELS = Object.freeze(['basic', 'intermediate', 'advanced', 'expert']);
/**
 * The columns this service reads and returns, named one by one: a column
 * added later (the Confluence ones, QA 10-23 #4) that is not migrated yet
 * then never breaks these reads. confluenceKnowledgeService reads its own
 * columns separately, and confluence_auth never leaves the server.
 */
export const SETTINGS_SELECT = Object.freeze({
  workspaceId: true, reviewDigestEnabled: true, reviewDigestSentAt: true, publishLevel: true, checkLevel: true, askAtClose: true,
  askDailyCap: true, stewardEnabled: true, stewardState: true, inboxWeeklyCap: true, updatedBy: true, updatedAt: true,
});
const CONTRIBUTION_DEFAULTS = Object.freeze({ publishLevel: 'intermediate', checkLevel: 'advanced', askAtClose: false, askDailyCap: 1, inboxWeeklyCap: 5, stewardEnabled: false });

function view(row, workspaceId) {
  return {
    workspaceId: Number(workspaceId),
    ...DEFAULT_KNOWLEDGE_SETTINGS,
    ...CONTRIBUTION_DEFAULTS,
    ...(row ? {
      reviewDigestEnabled: row.reviewDigestEnabled === true,
      reviewDigestSentAt: row.reviewDigestSentAt ?? null,
      // Contribution by skill and the nightly review (plans/KNOWLEDGE_SIMPLIFY_PLAN.md sections 7-10).
      publishLevel: CONTRIBUTION_LEVELS.includes(row.publishLevel) ? row.publishLevel : 'intermediate',
      checkLevel: CONTRIBUTION_LEVELS.includes(row.checkLevel) ? row.checkLevel : 'advanced',
      askAtClose: row.askAtClose === true,
      askDailyCap: Number.isInteger(row.askDailyCap) ? row.askDailyCap : 1,
      inboxWeeklyCap: Number.isInteger(row.inboxWeeklyCap) ? row.inboxWeeklyCap : 5,
      stewardEnabled: row.stewardEnabled === true,
      stewardState: row.stewardState && typeof row.stewardState === 'object' ? row.stewardState : null,
      updatedBy: row.updatedBy ?? null,
      updatedAt: row.updatedAt ?? null,
    } : {}),
  };
}

class KnowledgeSettingsService {
  async get(workspaceId) {
    const row = await Promise.resolve()
      .then(() => prisma.knowledgeSettings.findUnique({ where: { workspaceId: Number(workspaceId) }, select: SETTINGS_SELECT }))
      .catch((err) => { logger.warn(`Knowledge settings unavailable (ws ${workspaceId}): ${err.message}`); return null; });
    return view(row, workspaceId);
  }

  async update(workspaceId, input = {}, actor = null) {
    const data = {};
    if (input.reviewDigestEnabled !== undefined) data.reviewDigestEnabled = input.reviewDigestEnabled === true;
    for (const field of ['publishLevel', 'checkLevel']) {
      if (input[field] === undefined) continue;
      if (!CONTRIBUTION_LEVELS.includes(input[field])) throw new ValidationError(`${field} must be one of: ${CONTRIBUTION_LEVELS.join(', ')}`);
      data[field] = input[field];
    }
    if (input.askAtClose !== undefined) data.askAtClose = input.askAtClose === true;
    if (input.stewardEnabled !== undefined) data.stewardEnabled = input.stewardEnabled === true;
    for (const [field, min, max] of [['askDailyCap', 1, 5], ['inboxWeeklyCap', 1, 20]]) {
      if (input[field] === undefined) continue;
      const n = Number(input[field]);
      if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`);
      data[field] = n;
    }
    if (!Object.keys(data).length) throw new ValidationError('Nothing to change');
    const current = await this.get(workspaceId);
    // Checking can never need less skill than writing.
    const publish = data.publishLevel ?? current.publishLevel;
    const check = data.checkLevel ?? current.checkLevel;
    if (CONTRIBUTION_LEVELS.indexOf(check) < CONTRIBUTION_LEVELS.indexOf(publish)) {
      throw new ValidationError('The level that can check articles cannot be lower than the level that can write them');
    }
    const by = actor?.email || actor?.name || null;
    try {
      const row = await prisma.knowledgeSettings.upsert({
        where: { workspaceId: Number(workspaceId) },
        create: { workspaceId: Number(workspaceId), ...data, updatedBy: by },
        update: { ...data, updatedBy: by },
        select: SETTINGS_SELECT,
      });
      return view(row, workspaceId);
    } catch (err) {
      logger.warn(`Knowledge settings not saved (ws ${workspaceId}): ${err.message}`);
      throw new ValidationError('Knowledge settings could not be saved (is the database up to date?)');
    }
  }

  /** Bookkeeping written by the digest and steward workers. Never throws. */
  async record(workspaceId, data) {
    return Promise.resolve()
      .then(() => prisma.knowledgeSettings.upsert({
        where: { workspaceId: Number(workspaceId) },
        create: { workspaceId: Number(workspaceId), ...data },
        update: data,
        select: { workspaceId: true },
      }))
      .catch((err) => { logger.warn(`Knowledge settings bookkeeping failed (ws ${workspaceId}): ${err.message}`); return null; });
  }

  /** Workspaces with a switch on (bounded). */
  async enabledWorkspaces(field) {
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeSettings.findMany({ where: { [field]: true }, select: SETTINGS_SELECT, take: 100 }))
      .catch(() => []);
    return (rows || []).map((r) => view(r, r.workspaceId));
  }
}

const knowledgeSettingsService = new KnowledgeSettingsService();
export default knowledgeSettingsService;
export { KnowledgeSettingsService };
