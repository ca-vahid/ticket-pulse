/**
 * Per-workspace Knowledge switches (Auto-help P1): the FreshService solution
 * import (folders) and the weekly "review due" digest. Both off by default.
 * A missing table (migration not applied yet) reads as the defaults and
 * refuses writes with a clear message instead of a 500.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

export const MAX_FS_FOLDERS = 50;
export const DEFAULT_KNOWLEDGE_SETTINGS = Object.freeze({
  fsImportEnabled: false,
  fsFolderIds: [],
  fsImportState: null,
  fsImportedAt: null,
  reviewDigestEnabled: false,
  reviewDigestSentAt: null,
});

function view(row, workspaceId) {
  return {
    workspaceId: Number(workspaceId),
    ...DEFAULT_KNOWLEDGE_SETTINGS,
    ...(row ? {
      fsImportEnabled: row.fsImportEnabled === true,
      fsFolderIds: Array.isArray(row.fsFolderIds) ? row.fsFolderIds.map(String) : [],
      fsImportState: row.fsImportState ?? null,
      fsImportedAt: row.fsImportedAt ?? null,
      reviewDigestEnabled: row.reviewDigestEnabled === true,
      reviewDigestSentAt: row.reviewDigestSentAt ?? null,
      updatedBy: row.updatedBy ?? null,
      updatedAt: row.updatedAt ?? null,
    } : {}),
  };
}

export function cleanFolderIds(list) {
  if (!Array.isArray(list)) throw new ValidationError('fsFolderIds must be a list of FreshService folder ids');
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw new ValidationError(`"${id}" is not a FreshService folder id`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_FS_FOLDERS) throw new ValidationError(`Pick at most ${MAX_FS_FOLDERS} folders`);
  return out;
}

class KnowledgeSettingsService {
  async get(workspaceId) {
    const row = await Promise.resolve()
      .then(() => prisma.knowledgeSettings.findUnique({ where: { workspaceId: Number(workspaceId) } }))
      .catch((err) => { logger.warn(`Knowledge settings unavailable (ws ${workspaceId}): ${err.message}`); return null; });
    return view(row, workspaceId);
  }

  async update(workspaceId, input = {}, actor = null) {
    const data = {};
    if (input.fsImportEnabled !== undefined) data.fsImportEnabled = input.fsImportEnabled === true;
    if (input.fsFolderIds !== undefined) data.fsFolderIds = cleanFolderIds(input.fsFolderIds);
    if (input.reviewDigestEnabled !== undefined) data.reviewDigestEnabled = input.reviewDigestEnabled === true;
    if (!Object.keys(data).length) throw new ValidationError('Nothing to change');
    const current = await this.get(workspaceId);
    if ((data.fsImportEnabled ?? current.fsImportEnabled) && !(data.fsFolderIds ?? current.fsFolderIds).length) {
      throw new ValidationError('Pick at least one FreshService folder before switching the import on');
    }
    const by = actor?.email || actor?.name || null;
    try {
      const row = await prisma.knowledgeSettings.upsert({
        where: { workspaceId: Number(workspaceId) },
        create: { workspaceId: Number(workspaceId), ...data, updatedBy: by },
        update: { ...data, updatedBy: by },
      });
      return view(row, workspaceId);
    } catch (err) {
      logger.warn(`Knowledge settings not saved (ws ${workspaceId}): ${err.message}`);
      throw new ValidationError('Knowledge settings could not be saved (is the database up to date?)');
    }
  }

  /** Bookkeeping written by the import / digest workers. Never throws. */
  async record(workspaceId, data) {
    return Promise.resolve()
      .then(() => prisma.knowledgeSettings.upsert({
        where: { workspaceId: Number(workspaceId) },
        create: { workspaceId: Number(workspaceId), ...data },
        update: data,
      }))
      .catch((err) => { logger.warn(`Knowledge settings bookkeeping failed (ws ${workspaceId}): ${err.message}`); return null; });
  }

  /** Workspaces with a switch on (bounded). */
  async enabledWorkspaces(field) {
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeSettings.findMany({ where: { [field]: true }, take: 100 }))
      .catch(() => []);
    return (rows || []).map((r) => view(r, r.workspaceId));
  }
}

const knowledgeSettingsService = new KnowledgeSettingsService();
export default knowledgeSettingsService;
export { KnowledgeSettingsService };
