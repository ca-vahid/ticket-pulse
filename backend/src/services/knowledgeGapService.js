/**
 * Knowledge gaps (Auto-help P1, plans/AUTO_HELP_P1_PLAN.md §4 "Gap finder").
 *
 * Which questions keep arriving that Knowledge cannot answer? Two signals,
 * per playbook, over a window (default 90 days):
 *
 *   not answered    Auto-help runs that ended not_answerable because the
 *                   knowledge was missing or too thin: no_sources,
 *                   no_grounded_source, insufficient_context, uncited_step,
 *                   and model_declined (the model read what was found and
 *                   said it does not answer this).
 *   not picked up   categorized tickets in a playbook's category/subcategory
 *                   that no playbook matched (keywords / exclusions): demand
 *                   in the playbook's area it never tried to answer.
 *
 * Probe runs (trigger 'test' from the playbook test box, 'backtest' on old
 * resolved tickets) are not demand and never count, on either side.
 *
 * One entry per ticket (its latest such run); a ticket that later got a
 * drafted answer is no longer a gap. Tickets are clustered per playbook by
 * meaning (knowledgeGapClustering: mean-centered gist embeddings at 0.40, or
 * TF-IDF keywords when embeddings are off). Each cluster reports its typical
 * ticket's subject as a title, distinguishing keywords, count, example
 * tickets (subject only), last seen, how many are resolved (what a drafted
 * article can learn from) and any article already drafted from it.
 *
 * Computed on demand, cached 5 minutes per workspace + window. Bounded:
 * 1,500 runs, 600 tickets, 40 background tickets per playbook; gist vectors
 * are cached in process. Every read degrades to an empty result.
 */
import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { matchText } from './autoHelpPlaybookService.js';
import { embedQueryTexts, isEmbeddingConfigured } from './ticketEmbeddingService.js';
import {
  centerVectors, cleanSubject, clusterKeywords, gapTitle, greedyCluster, medoid, tfidfVectors,
} from './knowledgeGapClustering.js';
import { scrubPii } from '../utils/piiScrubber.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

export const GAP_GATES = Object.freeze(['no_sources', 'no_grounded_source', 'insufficient_context', 'uncited_step', 'model_declined']);
export const NOT_PICKED_UP = 'not_picked_up';
export const GAP_REASON_LABELS = Object.freeze({
  no_sources: 'Nothing in Knowledge matched',
  no_grounded_source: 'The answer could not cite an article',
  insufficient_context: 'What was found did not cover it fully',
  uncited_step: 'A step had no source',
  model_declined: 'What was found did not answer it',
  [NOT_PICKED_UP]: 'In the playbook\'s category, but its keywords did not pick it up',
});
/** Runs that probe a playbook, not requests from people: never a gap, never an answer. */
export const PROBE_TRIGGERS = Object.freeze(['test', 'backtest']);
export const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const RUN_SCAN = 1500;
const TICKET_CAP = 600;
const BACKGROUND_PER_PLAYBOOK = 40;
const EXAMPLES = 5;
const CLUSTER_TICKET_IDS = 50;
const CACHE_MS = 5 * 60 * 1000;
const VEC_CACHE_MAX = 5000;
const EMBED_BATCH = 100;
const GIST_BODY_CHARS = 400;
const ANSWERED = ['drafted', 'staged', 'sent'];
const TICKET_SELECT = Object.freeze({
  id: true, workspaceId: true, subject: true, descriptionText: true, status: true, isNoise: true, createdAt: true,
  resolvedAt: true, solutionVerifiedAt: true, origin: true, nativeNumber: true, freshserviceTicketId: true,
  internalCategoryId: true, internalSubcategoryId: true,
  requester: { select: { name: true, email: true } },
});

/** Subject + the start of the cleaned description (legal disclaimer cut): what a ticket asks. */
export function gistOf(ticket) {
  const text = matchText(ticket);
  const body = text.slice(text.indexOf('\n') + 1).replace(/\s+/g, ' ').trim().slice(0, GIST_BODY_CHARS);
  return `${cleanSubject(ticket?.subject)}\n${body}`.trim();
}

/** The gist with the requester's name and other PII scrubbed: what cluster labels are made from. */
export function labelTextOf(ticket) {
  const people = ticket?.requester ? [{ ...ticket.requester, role: 'person' }] : [];
  return scrubPii(gistOf(ticket), { people });
}

function isResolved(t) {
  return Boolean(t?.resolvedAt) || ['Resolved', 'Closed'].includes(String(t?.status || ''));
}

/** Does this playbook's category/subcategory cover the ticket (keywords ignored)? */
export function coversCategory(playbook, ticket) {
  if (!playbook?.categoryId || Number(ticket?.internalCategoryId) !== Number(playbook.categoryId)) return false;
  const subs = (Array.isArray(playbook.subcategoryIds) ? playbook.subcategoryIds : []).map(Number).filter(Boolean);
  return !subs.length || subs.includes(Number(ticket?.internalSubcategoryId));
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

class KnowledgeGapService {
  constructor() {
    this.cache = new Map();
    this.vecCache = new Map();
  }

  clearCache(workspaceId = null) {
    if (workspaceId === null) this.cache.clear();
    else for (const k of this.cache.keys()) if (k.startsWith(`${workspaceId}:`)) this.cache.delete(k);
  }

  async gaps(workspaceId, { days = DEFAULT_DAYS, refresh = false } = {}) {
    const window = Math.min(MAX_DAYS, Math.max(7, Math.round(Number(days) || DEFAULT_DAYS)));
    const key = `${Number(workspaceId)}:${window}`;
    const hit = this.cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, cached: true };
    const data = await this.compute(workspaceId, { days: window });
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  /** Gist vectors for tickets, embedded in batches and cached by content. null = embeddings unavailable. */
  async _vectors(tickets) {
    if (!isEmbeddingConfigured()) return null;
    const out = new Map();
    const todo = [];
    for (const t of tickets) {
      const gist = gistOf(t);
      const k = `${t.id}:${sha1(gist)}`;
      if (this.vecCache.has(k)) out.set(t.id, this.vecCache.get(k));
      else todo.push({ id: t.id, gist, k });
    }
    try {
      for (let i = 0; i < todo.length; i += EMBED_BATCH) {
        const batch = todo.slice(i, i + EMBED_BATCH);
        const vecs = await embedQueryTexts(batch.map((b) => b.gist));
        if (!Array.isArray(vecs)) return null;
        batch.forEach((b, j) => {
          if (!Array.isArray(vecs[j]) || !vecs[j].length) return;
          out.set(b.id, vecs[j]);
          this.vecCache.set(b.k, vecs[j]);
        });
      }
    } catch (err) {
      logger.warn(`Knowledge gaps: embeddings failed — keyword clustering (${err.message})`);
      return null;
    }
    while (this.vecCache.size > VEC_CACHE_MAX) this.vecCache.delete(this.vecCache.keys().next().value);
    return out;
  }

  async compute(workspaceId, { days = DEFAULT_DAYS } = {}) {
    const ws = Number(workspaceId);
    const since = new Date(Date.now() - days * 86400e3);
    const empty = { generatedAt: new Date(), days, mode: null, totals: { tickets: 0, clusters: 0 }, playbooks: [] };

    const [runs, playbookRows] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpRun.findMany({
        where: {
          workspaceId: ws,
          createdAt: { gte: since },
          trigger: { notIn: [...PROBE_TRIGGERS] },
          OR: [
            { status: 'not_answerable', gateDecision: { in: [...GAP_GATES] } },
            { status: 'no_match', trigger: 'categorized' },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: RUN_SCAN,
        select: { id: true, ticketId: true, playbookId: true, status: true, gateDecision: true, createdAt: true },
      })).catch((err) => { logger.warn(`Knowledge gaps: runs unavailable (ws ${ws}): ${err.message}`); return []; }),
      Promise.resolve().then(() => prisma.autoHelpPlaybook.findMany({
        where: { workspaceId: ws },
        select: { id: true, name: true, enabled: true, categoryId: true, subcategoryIds: true, priority: true },
        take: 200,
      })).catch(() => []),
    ]);
    if (!runs?.length || !playbookRows?.length) return empty;
    const playbooks = [...playbookRows].sort((a, b) => (Number(b.priority ?? 100) - Number(a.priority ?? 100)) || (a.id - b.id));

    // Latest gap run per ticket.
    const latest = new Map();
    for (const r of runs) if (!latest.has(r.ticketId)) latest.set(r.ticketId, r);
    const ids = [...latest.keys()].slice(0, TICKET_CAP);

    const [answeredRuns, tickets] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpRun.findMany({
        where: { workspaceId: ws, ticketId: { in: ids }, status: { in: ANSWERED }, trigger: { notIn: [...PROBE_TRIGGERS] } },
        select: { ticketId: true, createdAt: true },
        take: 3000,
      })).catch(() => []),
      Promise.resolve().then(() => prisma.ticket.findMany({ where: { workspaceId: ws, id: { in: ids } }, select: TICKET_SELECT, take: TICKET_CAP }))
        .catch((err) => { logger.warn(`Knowledge gaps: tickets unavailable (ws ${ws}): ${err.message}`); return []; }),
    ]);
    const answeredAfter = new Map();
    for (const a of answeredRuns || []) {
      const prev = answeredAfter.get(a.ticketId);
      if (!prev || new Date(a.createdAt) > prev) answeredAfter.set(a.ticketId, new Date(a.createdAt));
    }

    // Ticket -> playbook group.
    const groups = new Map();
    for (const t of tickets || []) {
      if (t.workspaceId !== ws || t.isNoise || ['Deleted', 'Spam'].includes(t.status)) continue;
      const run = latest.get(t.id);
      if (!run) continue;
      const answered = answeredAfter.get(t.id);
      if (answered && answered > new Date(run.createdAt)) continue;
      const pb = run.playbookId
        ? playbooks.find((p) => p.id === run.playbookId)
        : playbooks.find((p) => coversCategory(p, t));
      if (!pb) continue; // not in any playbook's area: not a gap we can act on here
      const reason = run.status === 'no_match' ? NOT_PICKED_UP : run.gateDecision;
      if (!groups.has(pb.id)) groups.set(pb.id, { playbook: pb, items: [] });
      groups.get(pb.id).items.push({ ticket: t, run, reason, at: run.createdAt });
    }
    if (!groups.size) return empty;

    // Background tickets per playbook category, for centering.
    const background = new Map();
    if (isEmbeddingConfigured()) {
      await Promise.all([...groups.values()].map(async (g) => {
        const rows = await Promise.resolve().then(() => prisma.ticket.findMany({
          where: {
            workspaceId: ws,
            internalCategoryId: g.playbook.categoryId,
            isNoise: false,
            id: { notIn: g.items.map((i) => i.ticket.id) },
          },
          orderBy: { createdAt: 'desc' },
          take: BACKGROUND_PER_PLAYBOOK,
          select: { id: true, subject: true, descriptionText: true },
        })).catch(() => []);
        background.set(g.playbook.id, rows || []);
      }));
    }

    const allTickets = [...groups.values()].flatMap((g) => g.items.map((i) => i.ticket));
    const vectors = await this._vectors([...allTickets, ...[...background.values()].flat()]);
    const mode = vectors && allTickets.every((t) => vectors.has(t.id)) ? 'dense' : 'sparse';

    const drafted = await Promise.resolve().then(() => prisma.knowledgeArticle.findMany({
      // Pre-v2 drafts carry the tag; v2 drafts only sourceMeta.draftedFrom
      // (same filter as articleDraftService.draftedArticleFilter, inlined to
      // keep this module's imports light).
      where: {
        workspaceId: ws,
        status: { not: 'archived' },
        OR: [
          { tags: { has: 'drafted-from-tickets' } },
          ...['tickets', 'gap', 'promote'].map((kind) => ({ sourceMeta: { path: ['draftedFrom', 'kind'], equals: kind } })),
        ],
      },
      select: { id: true, title: true, status: true, sourceMeta: true },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })).catch(() => []);

    const out = [];
    let clusterCount = 0;
    for (const g of groups.values()) {
      const items = g.items;
      let vecs;
      if (mode === 'dense') {
        const bg = (background.get(g.playbook.id) || []).map((b) => vectors.get(b.id)).filter(Boolean);
        vecs = centerVectors(items.map((i) => vectors.get(i.ticket.id)), bg);
      } else {
        vecs = tfidfVectors(items.map((i) => ({ subject: i.ticket.subject, body: gistOf(i.ticket) })));
      }
      const clusters = greedyCluster(items.map((i, k) => ({ id: i.ticket.id, vec: vecs[k], at: i.at, item: i })), { mode });
      // Labels (title + keywords) are built from scrubbed text: no names.
      const allTexts = items.map((i) => labelTextOf(i.ticket));
      const views = clusters.map((c) => this._clusterView(g.playbook, c, mode, allTexts, drafted || []));
      clusterCount += views.length;
      out.push({
        playbookId: g.playbook.id,
        playbookName: g.playbook.name,
        enabled: g.playbook.enabled,
        tickets: items.length,
        clusters: views,
      });
    }
    out.sort((a, b) => b.tickets - a.tickets);
    return {
      generatedAt: new Date(),
      days,
      mode,
      totals: { tickets: allTickets.length, clusters: clusterCount },
      playbooks: out,
    };
  }

  _clusterView(playbook, cluster, mode, allTexts, drafted) {
    const members = cluster.members.map((m) => m.item);
    const typical = medoid(cluster, mode).item;
    const keywords = clusterKeywords(members.map((m) => labelTextOf(m.ticket)), allTexts, { limit: 4 });
    const reasons = {};
    for (const m of members) reasons[m.reason] = (reasons[m.reason] || 0) + 1;
    const ticketIds = members.map((m) => m.ticket.id);
    const times = members.map((m) => new Date(m.at).getTime());
    const idSet = new Set(ticketIds);
    const article = drafted.find((a) => {
      const fed = Array.isArray(a?.sourceMeta?.draftedFrom?.ticketIds) ? a.sourceMeta.draftedFrom.ticketIds : [];
      if (!fed.length) return false;
      const overlap = fed.filter((id) => idSet.has(Number(id))).length;
      return overlap >= Math.max(1, Math.ceil(Math.min(fed.length, ticketIds.length) / 2));
    }) || null;
    return {
      key: `${playbook.id}:${typical.ticket.id}`,
      title: gapTitle(typical.ticket.subject, { people: [typical.ticket.requester], keywords }),
      keywords,
      count: members.length,
      notPickedUp: reasons[NOT_PICKED_UP] || 0,
      reasons,
      firstSeenAt: new Date(Math.min(...times)),
      lastSeenAt: new Date(Math.max(...times)),
      resolvedCount: members.filter((m) => isResolved(m.ticket) || m.ticket.solutionVerifiedAt).length,
      ticketIds: ticketIds.slice(0, CLUSTER_TICKET_IDS),
      examples: members.slice(0, EXAMPLES).map((m) => ({
        id: m.ticket.id,
        ref: ticketDisplayRef(m.ticket),
        subject: m.ticket.subject || '(no subject)',
        createdAt: m.ticket.createdAt,
        resolved: isResolved(m.ticket),
        reason: m.reason,
      })),
      article: article ? { id: article.id, title: article.title, status: article.status } : null,
    };
  }
}

const knowledgeGapService = new KnowledgeGapService();
export default knowledgeGapService;
export { KnowledgeGapService };
