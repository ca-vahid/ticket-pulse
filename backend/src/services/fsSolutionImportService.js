/**
 * FreshService solution articles -> Knowledge (Auto-help P1,
 * plans/AUTO_HELP_P1_PLAN.md §4; optional per workspace, off by default).
 *
 * An admin picks FreshService solution folders (listed live from
 * GET /solutions/categories and /solutions/folders?category_id=); a nightly
 * import (quiet hours, knowledgeGrowthWorker) reads the PUBLISHED articles
 * (status 2) of those folders with GET /solutions/articles?folder_id=
 * (per_page 100, paged) and keeps one Knowledge article per FreshService
 * article: source 'fs_solution', externalId = the FreshService id,
 * fsUpdatedAt = its updated_at, read-only in Ticket Pulse ("Edit in
 * FreshService"). Then sections + embeddings like any published article.
 *
 * One writer per workspace: every run (nightly tick or "Import now", in any
 * container) takes a Postgres advisory lock keyed by the workspace
 * (pg_try_advisory_xact_lock) and skips when another run holds it; the
 * partial unique index (workspace_id, source, external_id) WHERE external_id
 * IS NOT NULL backs it up, and a create that hits it becomes an update.
 *
 * Paging follows FreshService's Link header: a page with rel="next" is
 * followed; a page WITHOUT a Link header proves nothing (FreshService omits
 * it on the last page, and a short page is not proof either), so the walk
 * continues until an empty page. Only a listing that reached its end counts
 * as complete.
 *
 * Idempotent: an article whose FreshService updated_at is unchanged is not
 * re-read; one whose title + text hash is unchanged is not re-indexed. One
 * article that fails is logged and skipped, never fatal. Unpublished in
 * FreshService or deleted there -> archived here, but ONLY when every picked
 * folder (and the folder list itself) was listed completely in this run — a
 * partial listing never archives anything. A folder unticked here -> its
 * articles archived. An article someone archived in Ticket Pulse stays
 * archived. Picked folder ids are checked against the workspace's live
 * FreshService folder list (on save and on every run): a folder that is not
 * there is never imported.
 *
 * Lanes: the folder picker and "Import now" are things a person waits on, so
 * they use the INTERACTIVE FreshService client (priority 'high', 15 s queue
 * budget — the same lane as mirrorService.getInteractiveClient); "Import now"
 * runs in the background with its progress in knowledge_settings
 * .fs_import_state (job id + heartbeat, readable from any container). The
 * nightly import uses the LOW-priority lane (source 'kb-solution-import'), so
 * ticket syncs and people always go first. Outside production the import
 * never calls FreshService: fsCallsAllowed() is false and run() stops at a
 * dry-run plan (KNOWLEDGE_FS_IMPORT_ALLOW_NONPROD=true lifts it for a
 * deliberate test).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ConflictError, ValidationError } from '../utils/errors.js';
import { createFreshServiceClient } from '../integrations/freshservice.js';
import settingsRepository from './settingsRepository.js';
import knowledgeSettingsService from './knowledgeSettingsService.js';
import knowledgeArticleService, { articleContentHash, htmlToText, sanitizeArticleHtml } from './knowledgeArticleService.js';

export const FS_PUBLISHED = 2;
export const PER_PAGE = 100;
export const MAX_PAGES = 20;
export const MAX_CATEGORIES = 50;
const FOLDER_CACHE_MS = 10 * 60 * 1000;
const EXISTING_PAGE = 1000;
const EXISTING_MAX = 50000;
const IMPORT_SOURCE = 'freshservice-import';
/** Advisory-lock namespace ("KB"); the second key is the workspace id. */
export const LOCK_NAMESPACE = 0x4b42;
const LOCK_TX_TIMEOUT_MS = 60 * 60 * 1000;
const PROGRESS_EVERY_MS = 2000;
/** A 'running' import whose progress has not moved for this long is reported interrupted. */
export const IMPORT_STALE_MS = 5 * 60 * 1000;

export function fsCallsAllowed(env = process.env) {
  return env.NODE_ENV === 'production' || env.KNOWLEDGE_FS_IMPORT_ALLOW_NONPROD === 'true';
}

function fullDomain(domain) {
  const d = String(domain || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!d) return null;
  return d.includes('.') ? d : `${d}.freshservice.com`;
}

/** Where an agent edits the article in FreshService. */
export function fsArticleUrl(domain, id) {
  const d = fullDomain(domain);
  return d ? `https://${d}/a/solutions/articles/${id}` : null;
}

/** 'next' when the Link header names a next page, 'last' when it exists without one, null when absent. */
export function linkNext(headers) {
  const raw = headers?.link ?? headers?.Link ?? (typeof headers?.get === 'function' ? headers.get('link') : null);
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return /<[^>]+>\s*;\s*rel="?next"?/i.test(String(raw)) ? 'next' : 'last';
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && x === y;
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Untitled FreshService article';
}

function fsTags(tags) {
  const out = ['freshservice'];
  for (const t of Array.isArray(tags) ? tags : []) {
    const tag = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
}

const isUniqueViolation = (err) => err?.code === 'P2002' || /unique constraint/i.test(String(err?.message || ''));

class FsSolutionImportService {
  constructor() {
    this.folderCache = new Map();
    this.running = new Set();
    this.clientFactory = null; // test seam: (workspaceId, { interactive }) => client
    this.lockFn = null; // test seam: (workspaceId, fn) => { locked, result }
  }

  /**
   * A FreshService client on the right lane: interactive (a person is
   * waiting) = priority 'high' with a 15 s queue budget, like
   * mirrorService.getInteractiveClient; background = priority 'low'.
   */
  async _client(workspaceId, { interactive = false } = {}) {
    if (this.clientFactory) {
      const client = await this.clientFactory(workspaceId, { interactive });
      return { client, fsWorkspaceId: client?.fsWorkspaceId || null };
    }
    const cfg = await settingsRepository.getFreshServiceConfigForWorkspace(Number(workspaceId));
    if (!cfg?.domain || !cfg?.apiKey) throw new ValidationError('FreshService is not configured for this workspace');
    const client = createFreshServiceClient(cfg.domain, cfg.apiKey, interactive
      ? { priority: 'high', source: 'interactive-ui', queueTimeoutMs: 15000 }
      : { priority: 'low', source: 'kb-solution-import', queueTimeoutMs: 5 * 60 * 1000 });
    return { client, fsWorkspaceId: cfg.workspaceId || null };
  }

  /**
   * Every page of a solutions list (bounded). Follows the Link header; with
   * no Link header, walks on until an empty page (a short page is not the
   * end). Throws on any failed page. { items, complete }.
   */
  async _pages(client, endpoint, params, key) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await client._fetchWithRetry(endpoint, { params: { ...params, page, per_page: PER_PAGE } });
      const list = Array.isArray(res?.data?.[key]) ? res.data[key] : [];
      out.push(...list);
      if (!list.length) return { items: out, complete: true };
      const link = linkNext(res?.headers);
      if (link === 'last') return { items: out, complete: true };
      // 'next' -> follow it; null (no header) -> keep going until an empty page.
    }
    logger.warn(`FS solution import: ${endpoint} ${JSON.stringify(params)} stopped at ${MAX_PAGES} pages`);
    return { items: out, complete: false };
  }

  /**
   * FreshService solution categories with their folders, for the folder
   * picker (interactive lane). Cached 10 minutes.
   * { categories: [{ id, name, folders: [{ id, name, description }] }], complete, fetchedAt }
   * complete = every category and folder list reached its end.
   */
  async listFolders(workspaceId, { refresh = false, interactive = true, clientBundle = null } = {}) {
    if (!fsCallsAllowed() && !this.clientFactory) {
      throw new ValidationError('The FreshService folder list is only fetched in production (local runs never call FreshService).');
    }
    const ws = Number(workspaceId);
    const hit = this.folderCache.get(ws);
    if (!refresh && hit && Date.now() - hit.at < FOLDER_CACHE_MS) return hit.data;
    const { client, fsWorkspaceId } = clientBundle || await this._client(ws, { interactive });
    const catParams = fsWorkspaceId ? { workspace_id: fsWorkspaceId } : {};
    const cats = await this._pages(client, '/solutions/categories', catParams, 'categories');
    let complete = cats.complete && cats.items.length <= MAX_CATEGORIES;
    const out = [];
    for (const c of cats.items.slice(0, MAX_CATEGORIES)) {
      const folders = await this._pages(client, '/solutions/folders', { category_id: c.id }, 'folders');
      if (!folders.complete) complete = false;
      out.push({
        id: String(c.id),
        name: c.name || `Category ${c.id}`,
        folders: folders.items.map((f) => ({ id: String(f.id), name: f.name || `Folder ${f.id}`, description: f.description ? String(f.description).slice(0, 200) : null })),
      });
    }
    const data = { categories: out, complete, fetchedAt: new Date() };
    this.folderCache.set(ws, { at: Date.now(), data });
    return data;
  }

  /**
   * Which of these folder ids belong to this workspace's FreshService?
   * { valid, unknown, complete } — `unknown` is only certain when complete.
   */
  async checkFolderIds(workspaceId, ids, options = {}) {
    const list = await this.listFolders(workspaceId, { refresh: true, ...options });
    const known = new Set(list.categories.flatMap((c) => c.folders.map((f) => String(f.id))));
    const wanted = (ids || []).map(String);
    return { valid: wanted.filter((id) => known.has(id)), unknown: wanted.filter((id) => !known.has(id)), complete: list.complete };
  }

  /** Refuse to save folder ids that are not in this workspace's FreshService (when that can be checked). */
  async validateFolderIds(workspaceId, ids) {
    if (!ids?.length || (!fsCallsAllowed() && !this.clientFactory)) return { checked: false };
    const { unknown, complete } = await this.checkFolderIds(workspaceId, ids, { interactive: true });
    if (unknown.length && complete) {
      throw new ValidationError(`${unknown.length === 1 ? 'Folder' : 'Folders'} ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in this workspace's FreshService solutions. Pick from the list.`);
    }
    return { checked: true, unverified: complete ? [] : unknown };
  }

  /**
   * Run fn while holding this workspace's import lock (Postgres advisory
   * xact lock, held by an otherwise idle transaction for the run). Never
   * waits: { locked: false } when another run (any container) holds it.
   */
  async _withLock(ws, fn) {
    if (this.lockFn) return this.lockFn(ws, fn);
    let out = { locked: false };
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::int, ${Number(ws)}::int) AS locked`;
      if (!rows?.[0]?.locked) return;
      out = { locked: true, result: await fn() };
    }, { timeout: LOCK_TX_TIMEOUT_MS, maxWait: 10000 });
    return out;
  }

  /** Every existing imported article of the workspace, in id order (paged, complete). */
  async _existing(ws) {
    const rows = [];
    let cursor = 0;
    while (rows.length < EXISTING_MAX) {
      const page = await prisma.knowledgeArticle.findMany({
        where: { workspaceId: ws, source: 'fs_solution', id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: EXISTING_PAGE,
        select: { id: true, externalId: true, title: true, status: true, contentHash: true, fsUpdatedAt: true, sourceMeta: true },
      });
      if (!page?.length) break;
      rows.push(...page);
      cursor = page[page.length - 1].id;
      if (page.length < EXISTING_PAGE) break;
    }
    return rows;
  }

  /**
   * "Import now": runs in the background on the interactive lane. Returns
   * the job id at once (or the dry-run plan outside production). Progress:
   * jobStatus(ws, jobId).
   */
  async startImport(workspaceId, { actor = null, dryRun = false } = {}) {
    const ws = Number(workspaceId);
    const settings = await knowledgeSettingsService.get(ws);
    const folders = settings.fsFolderIds || [];
    if (!folders.length) return { skipped: 'no_folders' };
    if (dryRun || (!fsCallsAllowed() && !this.clientFactory)) return this.run(ws, { dryRun: true, force: true });
    const current = this._jobView(settings.fsImportState, settings);
    if (current?.status === 'running' || current?.status === 'queued') {
      throw new ConflictError('A FreshService import is already running for this workspace. Its progress is shown here.');
    }
    const jobId = `fsi-${ws}-${Date.now().toString(36)}`;
    const state = { jobId, status: 'queued', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), by: actor?.email || actor?.name || null, trigger: 'manual' };
    await knowledgeSettingsService.record(ws, { fsImportState: state });
    setImmediate(() => {
      this.run(ws, { force: true, interactive: true, jobId, trigger: 'manual', by: state.by })
        .catch((err) => logger.warn(`FS solution import job ${jobId} failed (ws ${ws}): ${err.message}`));
    });
    return { jobId, status: 'queued' };
  }

  /** A job's state as any container sees it; a 'running' job with no heartbeat for IMPORT_STALE_MS is 'interrupted'. */
  _jobView(state, settings = null) {
    if (!state || typeof state !== 'object') return null;
    const beat = state.heartbeatAt || state.at || settings?.updatedAt || null;
    const age = beat ? Date.now() - new Date(beat).getTime() : Infinity;
    if ((state.status === 'running' || state.status === 'queued') && age > IMPORT_STALE_MS) {
      return { ...state, status: 'interrupted', error: state.error || 'The import stopped (the server restarted or lost FreshService). Nothing was archived; run it again.' };
    }
    return state;
  }

  async jobStatus(workspaceId, jobId = null) {
    const settings = await knowledgeSettingsService.get(Number(workspaceId));
    const state = this._jobView(settings.fsImportState, settings);
    if (!jobId) return state;
    if (state?.jobId === jobId) return state;
    return { jobId, status: 'unknown', current: state };
  }

  /**
   * Import one workspace. Returns counts. With dryRun (or outside production)
   * it returns the plan and makes no FreshService call.
   */
  async run(workspaceId, {
    dryRun = false, force = false, interactive = false, jobId = null, trigger = 'nightly', by = null,
  } = {}) {
    const ws = Number(workspaceId);
    const settings = await knowledgeSettingsService.get(ws);
    const folders = settings.fsFolderIds || [];
    if (!force && !settings.fsImportEnabled) return { skipped: 'disabled' };
    if (!folders.length) return { skipped: 'no_folders' };
    if (dryRun || (!fsCallsAllowed() && !this.clientFactory)) {
      return {
        dryRun: true,
        reason: dryRun ? 'dry_run' : 'not_production',
        wouldCall: folders.map((f) => `GET /solutions/articles?folder_id=${f}&per_page=${PER_PAGE}&page=1..`),
      };
    }
    if (this.running.has(ws)) return { skipped: 'running' };
    this.running.add(ws);
    try {
      const locked = await this._withLock(ws, () => this._import(ws, { folders, interactive, jobId, trigger, by }));
      if (!locked.locked) {
        logger.info(`FS solution import (ws ${ws}): another run holds the lock — skipped`);
        return { skipped: 'running' };
      }
      return locked.result;
    } finally {
      this.running.delete(ws);
    }
  }

  async _import(ws, { folders, interactive, jobId, trigger, by }) {
    const started = Date.now();
    const counts = {
      created: 0, updated: 0, unchanged: 0, archived: 0, skippedUnpublished: 0,
      failedFolders: [], failedArticles: [], unknownFolders: [], archiveSkipped: null,
    };
    const base = { jobId, trigger, by, startedAt: new Date(started).toISOString() };
    let lastWrite = 0;
    const progress = { foldersTotal: folders.length, foldersDone: 0, articlesSeen: 0 };
    const writeProgress = async (force = false) => {
      if (!force && Date.now() - lastWrite < PROGRESS_EVERY_MS) return;
      lastWrite = Date.now();
      await knowledgeSettingsService.record(ws, {
        fsImportState: { ...base, ...counts, status: 'running', progress: { ...progress }, heartbeatAt: new Date().toISOString() },
      });
    };
    try {
      await writeProgress(true);
      const bundle = await this._client(ws, { interactive });
      const domain = bundle.client?.domain || null;

      // Only folders that exist in THIS workspace's FreshService are read.
      const check = await this.checkFolderIds(ws, folders, { clientBundle: bundle });
      counts.unknownFolders = check.unknown;
      if (check.unknown.length) {
        logger.warn(`FS solution import (ws ${ws}): folder(s) ${check.unknown.join(', ')} not in this FreshService${check.complete ? '' : ' (folder list incomplete)'} — not imported`);
      }
      const toImport = check.valid;
      progress.foldersTotal = toImport.length;

      const existing = await this._existing(ws);
      const byExt = new Map(existing.map((r) => [String(r.externalId), r]));
      const seen = new Set();
      const unpublished = new Set();
      let allComplete = check.complete;

      for (const folderId of toImport) {
        let listed;
        try {
          listed = await this._pages(bundle.client, '/solutions/articles', { folder_id: folderId }, 'articles');
        } catch (err) {
          allComplete = false;
          counts.failedFolders.push({ folderId, error: String(err.message || err).slice(0, 200) });
          logger.warn(`FS solution import (ws ${ws}): folder ${folderId} failed — nothing archived this run (${err.message})`);
          continue;
        }
        if (!listed.complete) allComplete = false;
        for (const a of listed.items) {
          const ext = String(a?.id ?? '');
          if (!ext) continue;
          progress.articlesSeen += 1;
          if (Number(a.status) !== FS_PUBLISHED) { counts.skippedUnpublished += 1; unpublished.add(ext); continue; }
          seen.add(ext);
          try {
            await this._upsertOne(ws, { article: a, folderId, row: byExt.get(ext), client: bundle.client, domain, counts });
          } catch (err) {
            // One bad article never stops the import (and is not archived: it was listed).
            counts.failedArticles.push({ id: ext, error: String(err.message || err).slice(0, 200) });
            logger.warn(`FS solution import (ws ${ws}): article ${ext} skipped (${err.message})`);
          }
          await writeProgress();
        }
        progress.foldersDone += 1;
        await writeProgress();
      }

      // Archive: a folder unticked here always; unpublished / deleted in
      // FreshService (or its folder gone from FreshService) only after a
      // COMPLETE listing of everything picked.
      if (!allComplete) counts.archiveSkipped = 'partial_listing';
      const unknown = new Set(counts.unknownFolders);
      for (const row of existing) {
        const ext = String(row.externalId);
        if (row.status === 'archived' || seen.has(ext)) continue;
        const folderId = row.sourceMeta?.folderId ? String(row.sourceMeta.folderId) : null;
        const folderRemoved = !folderId || !folders.includes(folderId);
        let reason = null;
        if (folderRemoved) reason = 'folder_removed';
        else if (allComplete) reason = unknown.has(folderId) ? 'folder_missing_in_fs' : (unpublished.has(ext) ? 'unpublished_in_fs' : 'deleted_in_fs');
        if (!reason) continue;
        try {
          await prisma.knowledgeArticle.update({
            where: { id: row.id },
            data: { status: 'archived', sourceMeta: { ...(row.sourceMeta || {}), archivedReason: reason }, updatedBy: IMPORT_SOURCE },
          });
          counts.archived += 1;
        } catch (err) {
          logger.warn(`FS solution import (ws ${ws}): archiving article ${row.id} failed (${err.message})`);
        }
      }
      const state = {
        ...base, ...counts, status: 'done', progress: { ...progress }, at: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(), durationMs: Date.now() - started, folders: toImport.length,
      };
      await knowledgeSettingsService.record(ws, { fsImportState: state, fsImportedAt: new Date() });
      logger.info(`FS solution import (ws ${ws}): ${counts.created} new, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.archived} archived${counts.archiveSkipped ? ' (partial listing: nothing archived from FreshService)' : ''}`);
      return state;
    } catch (err) {
      logger.warn(`FS solution import failed (ws ${ws}): ${err.message}`);
      await knowledgeSettingsService.record(ws, {
        fsImportState: { ...base, ...counts, status: 'failed', progress: { ...progress }, error: String(err.message).slice(0, 300), at: new Date().toISOString(), heartbeatAt: new Date().toISOString() },
      });
      throw err;
    }
  }

  /** Create, or — when the unique index says it already exists — update. */
  async _createOrUpdate(ws, ext, data) {
    try {
      return { row: await prisma.knowledgeArticle.create({ data }), created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await prisma.knowledgeArticle.findFirst({ where: { workspaceId: ws, source: 'fs_solution', externalId: ext }, select: { id: true, sourceMeta: true } });
      if (!existing) throw err;
      if (existing.sourceMeta?.archivedInTp) return { row: null, created: false, archivedInTp: true };
      const rest = { ...data };
      for (const k of ['workspaceId', 'source', 'externalId', 'createdBy']) delete rest[k];
      return { row: await prisma.knowledgeArticle.update({ where: { id: existing.id }, data: { ...rest, embedding: [], sections: [] } }), created: false };
    }
  }

  async _upsertOne(ws, { article: a, folderId, row, client, domain, counts }) {
    const ext = String(a.id);
    if (row?.sourceMeta?.archivedInTp) { counts.unchanged += 1; return; }
    const meta = {
      ...(row?.sourceMeta || {}),
      folderId: String(folderId),
      categoryId: a.category_id ? String(a.category_id) : (row?.sourceMeta?.categoryId ?? null),
      url: fsArticleUrl(domain, ext),
    };
    delete meta.archivedReason;
    const fsUpdatedAt = a.updated_at ? new Date(a.updated_at) : null;
    if (row && row.status === 'published' && sameInstant(row.fsUpdatedAt, fsUpdatedAt) && String(row.sourceMeta?.folderId) === String(folderId)) {
      counts.unchanged += 1;
      return;
    }
    let html = a.description;
    if (html === undefined || html === null) {
      const res = await client._fetchWithRetry(`/solutions/articles/${ext}`, {});
      html = res?.data?.article?.description ?? '';
    }
    const bodyHtml = sanitizeArticleHtml(html);
    const bodyText = htmlToText(bodyHtml);
    const title = cleanTitle(a.title);
    const contentHash = articleContentHash(title, bodyText);
    if (!bodyText) { counts.skippedUnpublished += 1; return; }
    if (!row) {
      const res = await this._createOrUpdate(ws, ext, {
        workspaceId: ws, source: 'fs_solution', externalId: ext, title, bodyHtml, bodyText, status: 'published',
        tags: fsTags(a.tags), contentHash, fsUpdatedAt, sourceMeta: meta, lastVerifiedAt: fsUpdatedAt || new Date(),
        createdBy: IMPORT_SOURCE, updatedBy: IMPORT_SOURCE,
      });
      if (res.archivedInTp) { counts.unchanged += 1; return; }
      await knowledgeArticleService.indexArticle(res.row);
      if (res.created) counts.created += 1;
      else counts.updated += 1;
      return;
    }
    if (row.contentHash === contentHash && row.status === 'published') {
      await prisma.knowledgeArticle.update({ where: { id: row.id }, data: { fsUpdatedAt, sourceMeta: meta } });
      counts.unchanged += 1;
      return;
    }
    const updated = await prisma.knowledgeArticle.update({
      where: { id: row.id },
      data: {
        title, bodyHtml, bodyText, status: 'published', tags: fsTags(a.tags), contentHash, fsUpdatedAt, sourceMeta: meta,
        lastVerifiedAt: fsUpdatedAt || new Date(), embedding: [], sections: [], updatedBy: IMPORT_SOURCE,
      },
    });
    await knowledgeArticleService.indexArticle(updated);
    counts.updated += 1;
  }

  /** Nightly: every workspace with the import on (low-priority lane). Never throws. */
  async runAll() {
    const workspaces = await knowledgeSettingsService.enabledWorkspaces('fsImportEnabled');
    const out = [];
    for (const s of workspaces) {
      const r = await this.run(s.workspaceId, { trigger: 'nightly' }).catch((err) => ({ error: err.message }));
      out.push({ workspaceId: s.workspaceId, ...r });
    }
    return out;
  }
}

const fsSolutionImportService = new FsSolutionImportService();
export default fsSolutionImportService;
export { FsSolutionImportService };
