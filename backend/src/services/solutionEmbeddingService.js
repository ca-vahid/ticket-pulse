/**
 * Verified-solution embeddings (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §4).
 *
 * A verified solution is embedded from the ticket subject + the agent's
 * verified solution note (ticketEmbeddingService.solutionContentOf) — never
 * the description and never internal notes — into ticket_solution_embeddings,
 * so Auto-help's retrieval can match a new request against what FIXED a past
 * one by meaning, not only by shared words (autoHelpRunner._verifiedSolutions
 * reads them through nearestVerifiedSolutions).
 *
 * Nightly (knowledgeGrowthWorker, quiet hours), incremental by content hash:
 *
 *   - every verified ticket of the workspace is walked in id-ordered pages
 *     (bounded by MAX_SCAN), so an OLD verified solution is seen like a new
 *     one — nothing depends on being among the newest N;
 *   - unchanged solutions cost nothing, a changed note is re-embedded, a
 *     moved category is updated without a new embedding call;
 *   - a vector is deleted ONLY when its ticket is gone, lost its verified
 *     mark, moved workspace, or its note was emptied (the stale check walks
 *     the stored vectors and looks their tickets up — it never infers "stale"
 *     from a bounded list of recent tickets);
 *   - the per-run budget goes first to NEW work (a solution verified in the
 *     last NEW_WINDOW_DAYS, or one whose text changed), newest first; what is
 *     left backfills older never-embedded solutions OLDEST first, a slice per
 *     night until the workspace has caught up.
 *
 * Best-effort throughout: no OpenAI key or a missing table returns a reason
 * instead of throwing.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import {
  EMBEDDING_MODEL, embedQueryTexts, isEmbeddingConfigured, solutionContentOf, solutionHashOf,
} from './ticketEmbeddingService.js';

export const SOLUTION_EMBED_MAX_PER_RUN = 400;
export const NEW_WINDOW_DAYS = 14;
export const PAGE = 500;
export const MAX_SCAN = 50000;
const BATCH = 64;
const BATCH_PAUSE_MS = 300;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Order the work: new / changed solutions newest first, then the backfill of
 * older never-embedded ones oldest first. Pure; exported for tests.
 */
export function orderWork(todo, now = new Date()) {
  const cutoff = now.getTime() - NEW_WINDOW_DAYS * 86400e3;
  const at = (t) => (t.verifiedAt ? new Date(t.verifiedAt).getTime() : 0);
  const fresh = todo.filter((t) => t.changed || at(t) >= cutoff).sort((a, b) => (at(b) - at(a)) || (b.ticketId - a.ticketId));
  const backfill = todo.filter((t) => !(t.changed || at(t) >= cutoff)).sort((a, b) => (at(a) - at(b)) || (a.ticketId - b.ticketId));
  return { fresh, backfill, ordered: [...fresh, ...backfill] };
}

class SolutionEmbeddingService {
  constructor() {
    this.pauseMs = BATCH_PAUSE_MS;
  }

  /** Walk every verified ticket (id order) and classify it against its stored vector. */
  async _scan(ws) {
    const todo = [];
    const recategorize = [];
    let unchanged = 0;
    let scanned = 0;
    let cursor = 0;
    while (scanned < MAX_SCAN) {
      const page = await prisma.ticket.findMany({
        where: { workspaceId: ws, solutionVerifiedAt: { not: null }, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: { id: true, subject: true, solutionNote: true, internalCategoryId: true, solutionVerifiedAt: true },
      });
      if (!page?.length) break;
      scanned += page.length;
      cursor = page[page.length - 1].id;
      const rows = await prisma.ticketSolutionEmbedding.findMany({
        where: { ticketId: { in: page.map((t) => t.id) } },
        select: { id: true, ticketId: true, contentHash: true, model: true, categoryId: true },
        take: page.length,
      });
      const byTicket = new Map((rows || []).map((r) => [r.ticketId, r]));
      for (const t of page) {
        const content = solutionContentOf(t);
        if (!content) continue; // verified with an empty note: nothing to embed (the stale pass drops its vector)
        const hash = solutionHashOf(content);
        const row = byTicket.get(t.id);
        if (row && row.contentHash === hash && row.model === EMBEDDING_MODEL) {
          if ((row.categoryId ?? null) !== (t.internalCategoryId ?? null)) recategorize.push({ id: row.id, categoryId: t.internalCategoryId ?? null });
          else unchanged += 1;
          continue;
        }
        todo.push({ ticketId: t.id, verifiedAt: t.solutionVerifiedAt || null, changed: Boolean(row) });
      }
      if (page.length < PAGE) break;
    }
    if (scanned >= MAX_SCAN) logger.warn(`Solution embeddings: ws ${ws} scan stopped at ${MAX_SCAN} verified tickets`);
    return { todo, recategorize, unchanged };
  }

  /**
   * Stored vectors whose ticket is gone, is no longer verified, moved
   * workspace or lost its note. Walks the vectors (id order), not a list of
   * recent tickets, so an old verified solution is never mistaken for stale.
   */
  async _staleIds(ws) {
    const stale = [];
    let cursor = 0;
    for (let scanned = 0; scanned < MAX_SCAN;) {
      const rows = await prisma.ticketSolutionEmbedding.findMany({
        where: { workspaceId: ws, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: PAGE,
        select: { id: true, ticketId: true },
      });
      if (!rows?.length) break;
      scanned += rows.length;
      cursor = rows[rows.length - 1].id;
      const tickets = await prisma.ticket.findMany({
        where: { id: { in: rows.map((r) => r.ticketId) } },
        select: { id: true, workspaceId: true, solutionVerifiedAt: true, solutionNote: true },
        take: rows.length,
      });
      const byId = new Map((tickets || []).map((t) => [t.id, t]));
      for (const r of rows) {
        const t = byId.get(r.ticketId);
        if (!t || t.workspaceId !== ws || !t.solutionVerifiedAt || !String(t.solutionNote || '').trim()) stale.push(r.id);
      }
      if (rows.length < PAGE) break;
    }
    return stale;
  }

  /**
   * Bring one workspace's solution vectors up to date.
   * @returns {Promise<{embedded:number, unchanged:number, recategorized:number, removed:number, pending:number, backfilled:number, backfillPending:number, skipped?:string}>}
   */
  async embedWorkspace(workspaceId, { max = SOLUTION_EMBED_MAX_PER_RUN, now = new Date(), mode = 'all' } = {}) {
    const ws = Number(workspaceId);
    const result = { embedded: 0, unchanged: 0, recategorized: 0, removed: 0, pending: 0, backfilled: 0, backfillPending: 0 };
    if (!isEmbeddingConfigured()) return { ...result, skipped: 'unconfigured' };

    let scan;
    let stale;
    try {
      scan = await this._scan(ws);
      stale = await this._staleIds(ws);
    } catch (err) {
      logger.warn(`Solution embeddings: ws ${ws} unavailable (${err.message})`);
      return { ...result, skipped: 'unavailable' };
    }
    result.unchanged = scan.unchanged;

    if (stale.length) {
      try {
        const res = await prisma.ticketSolutionEmbedding.deleteMany({ where: { workspaceId: ws, id: { in: stale } } });
        result.removed = res?.count ?? stale.length;
      } catch (err) {
        logger.warn(`Solution embeddings: ws ${ws} stale cleanup failed (${err.message})`);
      }
    }
    for (const r of scan.recategorize) {
      try {
        await prisma.ticketSolutionEmbedding.update({ where: { id: r.id }, data: { categoryId: r.categoryId } });
        result.recategorized += 1;
      } catch (err) {
        logger.warn(`Solution embeddings: category update failed (${err.message})`);
      }
    }

    const { fresh, backfill, ordered: all } = orderWork(scan.todo, now);
    // mode 'fresh' = only new / changed work; 'backfill' = only older solutions.
    const ordered = mode === 'fresh' ? fresh : mode === 'backfill' ? backfill : all;
    const freshIds = new Set(fresh.map((t) => t.ticketId));
    const budget = Math.max(0, Math.min(Number(max) || 0, ordered.length));
    const chosen = ordered.slice(0, budget);
    // Content is read again for just the chosen tickets (the scan keeps no text).
    const rows = chosen.length ? await Promise.resolve().then(() => prisma.ticket.findMany({
      where: { workspaceId: ws, id: { in: chosen.map((c) => c.ticketId) } },
      select: { id: true, subject: true, solutionNote: true, internalCategoryId: true },
      take: chosen.length,
    })).catch(() => []) : [];
    const byId = new Map((rows || []).map((t) => [t.id, t]));
    const work = chosen.map((c) => {
      const t = byId.get(c.ticketId);
      const content = t ? solutionContentOf(t) : '';
      return content ? { ticketId: c.ticketId, content, hash: solutionHashOf(content), categoryId: t.internalCategoryId ?? null } : null;
    }).filter(Boolean);

    for (let i = 0; i < work.length; i += BATCH) {
      const batch = work.slice(i, i + BATCH);
      let vectors;
      try {
        vectors = await embedQueryTexts(batch.map((b) => b.content));
      } catch (err) {
        logger.warn(`Solution embeddings: ws ${ws} batch failed — the next run resumes (${err.message})`);
        break;
      }
      if (!Array.isArray(vectors)) break;
      for (let j = 0; j < batch.length; j += 1) {
        const vec = vectors[j];
        if (!Array.isArray(vec) || !vec.length) continue;
        const b = batch[j];
        try {
          await prisma.ticketSolutionEmbedding.upsert({
            where: { ticketId: b.ticketId },
            create: { workspaceId: ws, ticketId: b.ticketId, categoryId: b.categoryId, embedding: vec, model: EMBEDDING_MODEL, contentHash: b.hash },
            update: { workspaceId: ws, categoryId: b.categoryId, embedding: vec, model: EMBEDDING_MODEL, contentHash: b.hash },
          });
          result.embedded += 1;
          if (!freshIds.has(b.ticketId)) result.backfilled += 1;
        } catch (err) {
          logger.warn(`Solution embeddings: ticket ${b.ticketId} not stored (${err.message})`);
        }
      }
      if (i + BATCH < work.length && this.pauseMs) await sleep(this.pauseMs);
    }
    result.pending = scan.todo.length - result.embedded;
    result.backfillPending = Math.max(0, scan.todo.length - fresh.length - result.backfilled);
    if (result.embedded || result.removed) {
      logger.info(`Solution embeddings ws ${ws}: ${result.embedded} embedded (${result.backfilled} backfill), ${result.removed} removed, ${result.pending} pending`);
    }
    return result;
  }

  /**
   * Every active workspace, one shared per-run budget. Never throws. New /
   * changed solutions in EVERY workspace come first; only the budget left
   * after that backfills older solutions (oldest first), so a workspace with
   * a big history never starves another's fresh work.
   */
  async runAll({ max = SOLUTION_EMBED_MAX_PER_RUN, now = new Date() } = {}) {
    if (!isEmbeddingConfigured()) return { skipped: 'unconfigured', workspaces: [] };
    const workspaces = await Promise.resolve()
      .then(() => prisma.workspace.findMany({ where: { isActive: true }, select: { id: true }, orderBy: { id: 'asc' }, take: 50 }))
      .catch(() => []);
    let left = Number(max) || 0;
    const byWs = new Map();
    for (const mode of ['fresh', 'backfill']) {
      for (const w of workspaces || []) {
        if (left <= 0) break;
        const prev = byWs.get(w.id);
        if (mode === 'backfill' && (prev?.skipped || prev?.error || !prev?.backfillPending)) continue;
        const r = await this.embedWorkspace(w.id, { max: left, now, mode }).catch((err) => ({ error: err.message, embedded: 0 }));
        left -= r.embedded || 0;
        byWs.set(w.id, prev ? {
          ...r,
          embedded: (prev.embedded || 0) + (r.embedded || 0),
          removed: (prev.removed || 0) + (r.removed || 0),
          recategorized: (prev.recategorized || 0) + (r.recategorized || 0),
        } : r);
      }
    }
    return { workspaces: [...byWs.entries()].map(([workspaceId, r]) => ({ workspaceId, ...r })) };
  }
}

const solutionEmbeddingService = new SolutionEmbeddingService();
export default solutionEmbeddingService;
export { SolutionEmbeddingService };
