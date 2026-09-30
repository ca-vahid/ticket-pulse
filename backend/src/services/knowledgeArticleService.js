/**
 * Knowledge articles (Auto-help P0, plans/AUTO_HELP_PLAN.md).
 *
 * The workspace's own answer library: short, grounded how-tos an agent (or
 * the Auto-help runner) can quote. Bodies are sanitized with the same email
 * allowlist the ticket-reply composer is held to server-side, so an article
 * can be pasted into a reply as-is.
 *
 * Search is hybrid and forgiving: whole-word keyword scoring over title /
 * body / tags always, plus cosine over the stored 256-d text-embedding-3-small
 * vector when both the article and the query could be embedded - both put on
 * one 0..1 scale by hybridScore(). Embedding is best-effort —
 * no OpenAI key or a failed call leaves `embedding` empty and search quietly
 * stays keyword-only.
 *
 * Governance (R1, plans/AUTO_HELP_PLAN.md → Research findings): every
 * article has an owner, a last-verified date (set on publish and by "Mark as
 * verified") and a review interval. Overdue articles still answer, but rank
 * lower (score x STALE_FACTOR) and are flagged stale in run sources.
 *
 * Sections (R2): a published article is split on its h1-h4 headings
 * (utils/articleSections.js) and each section embedded; search scores an
 * article by its best section and returns that section, which is what the
 * Auto-help model reads.
 */
import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { EMAIL_SANITIZE_OPTIONS } from './notificationWorkflowSignatureService.js';
import { cosineSimilarity, embedQueryTexts, isEmbeddingConfigured } from './ticketEmbeddingService.js';
import { containsWord } from '../utils/wordMatch.js';
import { htmlToText, splitArticleSections } from '../utils/articleSections.js';

export const ARTICLE_STATUSES = Object.freeze(['draft', 'published', 'archived']);
export const ARTICLE_SOURCES = Object.freeze(['tp', 'fs_solution', 'verified_ticket']);
/**
 * Where an article came from, in words (Knowledge v2). Provenance lives in
 * source / sourceMeta, not in the tags. Tags are Topics: shown for browsing,
 * and they also count in search (a topic hit weighs like a title hit).
 */
export const SOURCE_LABELS = Object.freeze({
  drafted: 'Drafted from tickets',
  fs_solution: 'FreshService solution',
  verified_ticket: 'Verified solution',
  tp: 'Written in Ticket Pulse',
});
/** The tag drafted articles carried before Knowledge v2 - hidden from Topics, read as provenance. */
export const LEGACY_DRAFTED_TAG = 'drafted-from-tickets';
export const MAX_TOPIC_SUGGESTIONS = 15;
/** "Quoted" counts look at this many recent runs at most (jsonb scan bound). */
const QUOTED_RUN_SCAN = 5000;
const MAX_TITLE = 300;
const MAX_BODY_HTML = 100000;
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 60;
const EMBED_CHARS = 6000;
// Search bounds (see search()): keyword candidates come from a SQL prefilter,
// semantic candidates from a paged scan of the stored vectors.
const KEYWORD_POOL = 300;
const KEYWORD_SQL_TOKENS = 12;
const VECTOR_PAGE = 500;
const VECTOR_SCAN_MAX = 5000;
const SEMANTIC_SHORTLIST = 50;
const SEARCH_SELECT = Object.freeze({
  id: true, title: true, bodyText: true, tags: true, categoryId: true, subcategoryId: true, updatedAt: true,
  createdAt: true, lastVerifiedAt: true, reviewEveryDays: true,
});
// Candidates whose sections are read for the final, section-level score.
const SECTION_POOL = 60;
const SECTION_EXCERPT = 2500;
const MAX_SECTIONS = 40;
export const DEFAULT_REVIEW_DAYS = 180;
export const STALE_FACTOR = 0.7;
export const DUPLICATE_TITLE_OVERLAP = 0.8;
const DAY_MS = 86400e3;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'you', 'your', 'can', 'not', 'but', 'please', 'thanks', 'thank', 'hi', 'hello', 'need', 'how', 'what', 'when', 'where', 'who', 'our', 'get', 'got', 'any', 'all', 'would', 'could', 'should', 'will', 'into', 'about', 'just', 'there', 'their', 'them', 'they', 'able']);

export { htmlToText };

// Headings are the article's structure: articleSections splits on them (R2),
// so h2-h4 must survive. A pasted h1 becomes a section heading (h2) and
// h5/h6 fold into h4, so every article uses the same three levels.
const ARTICLE_SANITIZE_OPTIONS = Object.freeze({
  ...EMAIL_SANITIZE_OPTIONS,
  allowedTags: [...new Set([...EMAIL_SANITIZE_OPTIONS.allowedTags.filter((t) => !/^h[1-6]$/.test(t)), 'h2', 'h3', 'h4'])],
  transformTags: {
    ...(EMAIL_SANITIZE_OPTIONS.transformTags || {}),
    h1: 'h2',
    h5: 'h4',
    h6: 'h4',
  },
});

export function sanitizeArticleHtml(html) {
  const raw = String(html || '').trim().slice(0, MAX_BODY_HTML);
  if (!raw) return '';
  return sanitizeHtml(raw, ARTICLE_SANITIZE_OPTIONS).trim();
}

function hashOf(title, text) {
  return crypto.createHash('sha256').update(`${title}\n${text}`).digest('hex');
}

/** The article content hash (title + plain text): the FreshService import compares with it. */
export const articleContentHash = hashOf;

/** FreshService solution articles are edited in FreshService; the import keeps them in step. */
export const FS_READ_ONLY_MESSAGE = 'This article comes from FreshService — edit it there; the nightly import brings the change in.';
function assertEditable(row) {
  if (row?.source === 'fs_solution') throw new ValidationError(FS_READ_ONLY_MESSAGE);
}

/** Lower-case, de-stopworded words of 3+ characters (keyword scoring). */
export function queryTokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || [];
  const out = [];
  for (const w of words) {
    const clean = w.replace(/[.-]+$/, '');
    if (clean.length < 3 || STOPWORDS.has(clean)) continue;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= 24) break;
  }
  return out;
}

export const CATEGORY_BOOST = Object.freeze({ subcategory: 0.12, category: 0.08 });

/**
 * Fraction of query tokens found as WHOLE words (containsWord: "app" never
 * hits "approval"), title and tag hits weighted double. 0..1.
 */
export function keywordScore(tokens, { title = '', bodyText = '', tags = [] } = {}) {
  if (!tokens.length) return 0;
  const tagText = (tags || []).map((x) => String(x)).join(' | ');
  let score = 0;
  for (const tok of tokens) {
    if (containsWord(title, tok) || containsWord(tagText, tok)) score += 2;
    else if (containsWord(bodyText, tok)) score += 1;
  }
  return Math.min(1, score / (tokens.length * 2));
}

/**
 * One scale for keyword and embedding relevance (25 Sep 2026 audit).
 * text-embedding-3-small cosines between unrelated IT requests sit around
 * 0.10-0.20 and near-duplicates reach 0.65+, so raw cosine is stretched from
 * [COSINE_FLOOR, COSINE_CEIL] onto 0..1 before it is blended with the 0..1
 * keyword fraction. Articles and verified solutions are scored with this same
 * function, so their numbers compare directly (and share RELEVANCE_FLOOR).
 */
export const COSINE_FLOOR = 0.15;
export const COSINE_CEIL = 0.65;
export const RELEVANCE_FLOOR = 0.2;
export function normalizeCosine(cosine) {
  if (cosine === null || cosine === undefined || !Number.isFinite(Number(cosine))) return null;
  return Math.min(1, Math.max(0, (Number(cosine) - COSINE_FLOOR) / (COSINE_CEIL - COSINE_FLOOR)));
}
export function hybridScore({ cosine = null, keyword = 0 } = {}) {
  const sem = normalizeCosine(cosine);
  const kw = Math.min(1, Math.max(0, Number(keyword) || 0));
  return sem === null ? kw : 0.65 * sem + 0.35 * kw;
}

/** When an article's accuracy review falls due (last verified, else created, + interval). */
export function reviewDueAt(row) {
  const base = row?.lastVerifiedAt || row?.createdAt || null;
  if (!base) return null;
  const days = Number(row?.reviewEveryDays) > 0 ? Number(row.reviewEveryDays) : DEFAULT_REVIEW_DAYS;
  return new Date(new Date(base).getTime() + days * DAY_MS);
}

/** Published and past its review date. */
export function isReviewOverdue(row, now = Date.now()) {
  if (row?.status && row.status !== 'published') return false;
  const due = reviewDueAt(row);
  return Boolean(due) && due.getTime() < now;
}

/** Title words for duplicate detection: lower-case, 2+ chars, no stopwords. */
export function titleTokens(title) {
  const words = String(title || '').toLowerCase().match(/[a-z0-9+#]+/g) || [];
  return [...new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !['to', 'in', 'on', 'of', 'a', 'an', 'my', 'or'].includes(w)))];
}

/** Normalized token overlap: shared words / the longer title's words (0..1). */
export function titleOverlap(a, b) {
  const x = titleTokens(a);
  const y = new Set(titleTokens(b));
  if (!x.length || !y.size) return 0;
  const shared = x.filter((w) => y.has(w)).length;
  return shared / Math.max(x.length, y.size);
}

function cleanEmail(value) {
  const e = String(value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.slice(0, 255) : null;
}

function clampReviewDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REVIEW_DAYS;
  return Math.min(730, Math.max(7, Math.round(n)));
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const raw of tags) {
    const tag = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_CHARS);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function intOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * One readable line from an article's text: list dashes dropped, and a line
 * with no closing punctuation gets one ("Connect:" for a short heading, a
 * full stop otherwise) so headings and steps don't run together.
 */
export function snippetOf(text, max = 220) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean);
  const s = lines
    .map((l, i) => (i === lines.length - 1 || /[.!?:;,)]$/.test(l) ? l : `${l}${l.length <= 48 ? ':' : '.'}`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const isLegacyDraftedTag = (tag) => String(tag || '').trim().toLowerCase() === LEGACY_DRAFTED_TAG;

/** "Drafted from tickets" / "FreshService solution" / "Verified solution" / "Written in Ticket Pulse". */
export function sourceLabelOf(row) {
  if (row?.source === 'fs_solution') return SOURCE_LABELS.fs_solution;
  if (row?.source === 'verified_ticket') return SOURCE_LABELS.verified_ticket;
  const drafted = Boolean(row?.sourceMeta && typeof row.sourceMeta === 'object' && row.sourceMeta.draftedFrom)
    || (Array.isArray(row?.tags) && row.tags.some(isLegacyDraftedTag));
  return drafted ? SOURCE_LABELS.drafted : SOURCE_LABELS.tp;
}

/**
 * Playbooks that can quote an article (Knowledge v2 "Quoted by"): same
 * category, and - when the playbook lists subcategories - the article's
 * subcategory is one of them, or the article has none (it covers the whole
 * category). Pure; exported for tests.
 */
export function playbooksReaching(article, playbooks = []) {
  const cat = Number(article?.categoryId) || null;
  if (!cat) return [];
  const sub = Number(article?.subcategoryId) || null;
  return (playbooks || [])
    .filter((pb) => Number(pb.categoryId) === cat)
    .filter((pb) => {
      const subs = Array.isArray(pb.subcategoryIds) ? pb.subcategoryIds.map(Number) : [];
      return !subs.length || !sub || subs.includes(sub);
    })
    .map((pb) => ({ playbookId: pb.id, name: pb.name, enabled: pb.enabled === true }));
}

/** API shape: never ships the vector, only whether one exists. */
export function articleView(row, { withBody = true, now = Date.now() } = {}) {
  if (!row) return null;
  const { embedding, sections, ...rest } = row;
  const list = Array.isArray(sections) ? sections : [];
  return {
    ...rest,
    // Topics only: the pre-v2 provenance tag moves to sourceLabel.
    tags: Array.isArray(row.tags) ? row.tags.filter((t) => !isLegacyDraftedTag(t)) : [],
    sourceLabel: sourceLabelOf(row),
    ...(withBody ? {} : { bodyHtml: undefined, bodyText: undefined }),
    snippet: snippetOf(row.bodyText),
    embedded: Array.isArray(embedding) && embedding.length > 0,
    sectionHeadings: list.map((x) => x?.heading || ''),
    sectionsEmbedded: list.length > 0 && list.every((x) => Array.isArray(x?.embedding) && x.embedding.length > 0),
    reviewDueAt: reviewDueAt(row),
    needsReview: isReviewOverdue(row, now),
    readOnly: row.source === 'fs_solution',
  };
}

function normalizeInput(input = {}, { partial = false } = {}) {
  const data = {};
  if (!partial || input.title !== undefined) {
    const title = String(input.title ?? '').replace(/\s+/g, ' ').trim();
    if (!title) throw new ValidationError('Give the article a title');
    data.title = title.slice(0, MAX_TITLE);
  }
  if (!partial || input.bodyHtml !== undefined) {
    data.bodyHtml = sanitizeArticleHtml(input.bodyHtml);
    data.bodyText = htmlToText(data.bodyHtml);
  }
  if (!partial || input.status !== undefined) {
    const status = String(input.status ?? 'draft').trim().toLowerCase();
    if (!ARTICLE_STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${ARTICLE_STATUSES.join(', ')}`);
    data.status = status;
  }
  if (!partial || input.tags !== undefined) data.tags = cleanTags(input.tags);
  if (!partial || input.categoryId !== undefined) data.categoryId = intOrNull(input.categoryId);
  if (!partial || input.subcategoryId !== undefined) data.subcategoryId = intOrNull(input.subcategoryId);
  if (!partial && input.source !== undefined) {
    const source = String(input.source).trim();
    if (!ARTICLE_SOURCES.includes(source)) throw new ValidationError(`source must be one of: ${ARTICLE_SOURCES.join(', ')}`);
    data.source = source;
  }
  if (!partial && input.externalId !== undefined && input.externalId !== null) {
    data.externalId = String(input.externalId).slice(0, 100);
  }
  if (!partial || input.ownerEmail !== undefined) {
    const owner = cleanEmail(input.ownerEmail);
    if (input.ownerEmail && !owner) throw new ValidationError('Owner must be an e-mail address');
    if (owner || partial) data.ownerEmail = owner;
  }
  if (!partial || input.reviewEveryDays !== undefined) data.reviewEveryDays = clampReviewDays(input.reviewEveryDays ?? DEFAULT_REVIEW_DAYS);
  if (data.status === 'published' && data.bodyText !== undefined && !data.bodyText) {
    throw new ValidationError('A published article needs a body');
  }
  return data;
}

class KnowledgeArticleService {
  async list(workspaceId, {
    q = '', status = null, categoryId = null, review = null, topic = null, owner = null, source = null, sort = null, limit = 100, offset = 0,
  } = {}) {
    const where = { workspaceId: Number(workspaceId) };
    // "Needs review": published articles past their review date. Dates are
    // compared in JS (interval is per row), over a bounded id/date scan.
    if (review === 'due') {
      const rows = await Promise.resolve()
        .then(() => prisma.knowledgeArticle.findMany({
          where: { workspaceId: Number(workspaceId), status: 'published' },
          select: { id: true, status: true, lastVerifiedAt: true, reviewEveryDays: true, createdAt: true },
          take: 5000,
        }))
        .catch(() => []);
      const now = Date.now();
      where.id = { in: (rows || []).filter((r) => isReviewOverdue(r, now)).map((r) => r.id) };
    }
    // Default view hides archived; 'all' shows everything.
    if (status && ARTICLE_STATUSES.includes(status)) where.status = status;
    else if (status !== 'all') where.status = { not: 'archived' };
    const and = [];
    const cat = intOrNull(categoryId);
    if (cat) and.push({ OR: [{ categoryId: cat }, { subcategoryId: cat }] });
    const text = String(q || '').trim();
    if (text) {
      and.push({
        OR: [
          { title: { contains: text, mode: 'insensitive' } },
          { bodyText: { contains: text, mode: 'insensitive' } },
          { tags: { has: text } },
        ],
      });
    }
    // Articles page filters (30 Sep 2026): a topic (as typed, any capitals),
    // an owner e-mail, a source ('tp' | 'fs_solution' | 'verified_ticket' | 'drafted').
    const topicText = String(topic || '').trim();
    if (topicText) {
      const variants = [...new Set([topicText, topicText.toLowerCase(), topicText.toUpperCase(), topicText.charAt(0).toUpperCase() + topicText.slice(1).toLowerCase()])];
      and.push({ tags: { hasSome: variants } });
    }
    const ownerText = String(owner || '').trim().toLowerCase();
    if (ownerText) and.push({ ownerEmail: { equals: ownerText, mode: 'insensitive' } });
    const sourceText = String(source || '').trim();
    if (sourceText === 'drafted') and.push({ tags: { has: 'drafted-from-tickets' } });
    else if (ARTICLE_SOURCES.includes(sourceText)) and.push({ source: sourceText });
    if (and.length) where.AND = and;
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const orderBy = sort === 'title' ? { title: 'asc' } : sort === 'oldest_verified' ? { lastVerifiedAt: { sort: 'asc', nulls: 'first' } } : { updatedAt: 'desc' };
    const [rows, total] = await Promise.all([
      Promise.resolve().then(() => prisma.knowledgeArticle.findMany({
        where,
        orderBy,
        take,
        skip,
        // The list shows title + snippet; vectors and section embeddings stay in the DB.
        omit: { embedding: true, sections: true, bodyHtml: true },
      })).catch((err) => {
        logger.warn(`Knowledge article list failed (ws ${workspaceId}): ${err.message}`);
        return [];
      }),
      Promise.resolve().then(() => prisma.knowledgeArticle.count({ where })).catch(() => 0),
    ]);
    let items = await this._withReach(workspaceId, rows.map((r) => articleView(r, { withBody: false })));
    // "Most quoted" sorts the page by what Auto-help actually cited.
    if (sort === 'quoted') items = [...items].sort((a, b) => (Number(b.timesQuoted) || 0) - (Number(a.timesQuoted) || 0));
    return { items, total };
  }

  /**
   * The Articles landing page (30 Sep 2026): counts, how much Auto-help
   * quoted them lately, and coverage — per top-level category, the last 30
   * days of tickets next to the published articles, so the gaps show.
   * Every part fails soft.
   */
  async overview(workspaceId) {
    const ws = Number(workspaceId);
    const since = new Date(Date.now() - 30 * 86400e3);
    const [byStatus, published, categories, ticketCounts, runs] = await Promise.all([
      Promise.resolve().then(() => prisma.knowledgeArticle.groupBy({ by: ['status'], where: { workspaceId: ws }, _count: { _all: true } })).catch(() => []),
      Promise.resolve().then(() => prisma.knowledgeArticle.findMany({
        where: { workspaceId: ws, status: 'published' },
        select: { id: true, categoryId: true, subcategoryId: true, lastVerifiedAt: true, reviewEveryDays: true, createdAt: true, status: true },
        take: 5000,
      })).catch(() => []),
      Promise.resolve().then(() => prisma.competencyCategory.findMany({
        where: { workspaceId: ws, isActive: true },
        select: { id: true, name: true, parentId: true },
        take: 2000,
      })).catch(() => []),
      Promise.resolve().then(() => prisma.ticket.groupBy({
        by: ['internalCategoryId'],
        where: { workspaceId: ws, createdAt: { gte: since }, internalCategoryId: { not: null } },
        _count: { _all: true },
      })).catch(() => []),
      Promise.resolve().then(() => prisma.autoHelpRun.findMany({
        where: { workspaceId: ws, createdAt: { gte: since } },
        select: { sources: true },
        take: 5000,
      })).catch(() => []),
    ]);
    const counts = Object.fromEntries((byStatus || []).map((g) => [g.status, g._count?._all || 0]));
    const now = Date.now();
    const quotedIds = new Map();
    for (const r of runs || []) {
      for (const src of Array.isArray(r.sources) ? r.sources : []) {
        if (src?.cited && src.type === 'article') quotedIds.set(src.id, (quotedIds.get(src.id) || 0) + 1);
      }
    }
    const parentOf = new Map((categories || []).map((c) => [c.id, c.parentId || null]));
    const topOf = (id) => {
      let cur = Number(id) || null;
      for (let i = 0; cur && parentOf.get(cur) && i < 5; i += 1) cur = parentOf.get(cur);
      return cur;
    };
    const coverage = new Map();
    const row = (id) => {
      if (!coverage.has(id)) {
        coverage.set(id, { categoryId: id, name: (categories || []).find((c) => c.id === id)?.name || `Category #${id}`, tickets30d: 0, published: 0 });
      }
      return coverage.get(id);
    };
    for (const g of ticketCounts || []) {
      const top = topOf(g.internalCategoryId);
      if (top) row(top).tickets30d += g._count?._all || 0;
    }
    for (const a of published || []) {
      const top = topOf(a.categoryId || a.subcategoryId);
      if (top) row(top).published += 1;
    }
    return {
      published: counts.published || 0,
      draft: counts.draft || 0,
      archived: counts.archived || 0,
      needsReview: (published || []).filter((a) => isReviewOverdue(a, now)).length,
      quoted30d: [...quotedIds.values()].reduce((sum, n) => sum + n, 0),
      articlesQuoted30d: quotedIds.size,
      coverage: [...coverage.values()].sort((a, b) => b.tickets30d - a.tickets30d || a.name.localeCompare(b.name)),
    };
  }

  async get(workspaceId, id) {
    const row = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
    if (!row) throw new NotFoundError('Article not found');
    const [view] = await this._withReach(workspaceId, [articleView(row)]);
    return view;
  }

  /**
   * Adds `quotedBy` (playbooksReaching) and `timesQuoted` (Auto-help runs
   * that CITED the article) to article views: one playbook read and one
   * grouped jsonb count for the whole page. Fails soft to [] / 0.
   */
  async _withReach(workspaceId, views) {
    if (!views.length) return views;
    const ws = Number(workspaceId);
    const [playbooks, quoted] = await Promise.all([
      Promise.resolve().then(() => prisma.autoHelpPlaybook.findMany({
        where: { workspaceId: ws },
        select: { id: true, name: true, enabled: true, categoryId: true, subcategoryIds: true },
        orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      })).catch(() => []),
      this.timesQuoted(ws, views.map((v) => v.id)),
    ]);
    return views.map((v) => ({
      ...v,
      quotedBy: playbooksReaching(v, Array.isArray(playbooks) ? playbooks : []),
      timesQuoted: quoted.get(v.id) || 0,
    }));
  }

  /**
   * Map(articleId -> runs that cited it): Auto-help runs of the workspace
   * whose `sources` hold { sourceId: 'article:<id>', cited: true }, over the
   * newest QUOTED_RUN_SCAN runs. Never throws (empty map).
   */
  async timesQuoted(workspaceId, articleIds = []) {
    const ids = [...new Set((articleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return new Map();
    const sourceIds = ids.map((id) => `article:${id}`);
    const rows = await Promise.resolve().then(() => prisma.$queryRaw`
      SELECT e->>'sourceId' AS "sourceId", COUNT(DISTINCT r.id)::int AS n
      FROM (
        SELECT id, sources FROM auto_help_runs
        WHERE workspace_id = ${Number(workspaceId)} AND jsonb_typeof(sources) = 'array'
        ORDER BY created_at DESC
        LIMIT ${QUOTED_RUN_SCAN}
      ) r
      CROSS JOIN LATERAL jsonb_array_elements(r.sources) e
      WHERE e->>'cited' = 'true' AND e->>'sourceId' = ANY(${sourceIds})
      GROUP BY 1
    `).catch((err) => { logger.warn(`Knowledge: quoted counts failed (ws ${workspaceId}): ${err.message}`); return []; });
    const out = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      const id = Number(String(r.sourceId || '').split(':')[1]);
      if (id) out.set(id, Number(r.n) || 0);
    }
    return out;
  }

  /**
   * Topic suggestions (Knowledge v2): the workspace's article tags (Topics)
   * that start with `q` (case-insensitive), grouped case-insensitively, most
   * used first, top MAX_TOPIC_SUGGESTIONS. Archived articles and the legacy
   * provenance tag are left out. Never throws.
   */
  async topics(workspaceId, { q = '' } = {}) {
    const prefix = String(q ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_TAG_CHARS);
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await Promise.resolve().then(() => prisma.$queryRaw`
      SELECT MIN(t) AS topic, COUNT(*)::int AS count
      FROM knowledge_articles a
      CROSS JOIN LATERAL unnest(a.tags) t
      WHERE a.workspace_id = ${Number(workspaceId)} AND a.status <> 'archived'
        AND lower(btrim(t)) LIKE ${like}
        AND lower(btrim(t)) <> ${LEGACY_DRAFTED_TAG}
      GROUP BY lower(btrim(t))
      ORDER BY count DESC, lower(btrim(t)) ASC
      LIMIT ${MAX_TOPIC_SUGGESTIONS}
    `).catch((err) => { logger.warn(`Knowledge: topics failed (ws ${workspaceId}): ${err.message}`); return []; });
    return (Array.isArray(rows) ? rows : [])
      .map((r) => ({ topic: String(r.topic || '').trim(), count: Number(r.count) || 0 }))
      .filter((r) => r.topic);
  }

  /**
   * @param {object} [options]
   * @param {object} [options.sourceMeta] server-side provenance only (drafted
   *   from tickets, FreshService folder) - never taken from a request body.
   */
  async create(workspaceId, input, actor = null, { sourceMeta = null } = {}) {
    const data = normalizeInput(input);
    const now = new Date();
    const row = await prisma.knowledgeArticle.create({
      data: {
        ...data,
        workspaceId: Number(workspaceId),
        ownerEmail: data.ownerEmail || cleanEmail(actor?.email) || null,
        ...(data.status === 'published' ? { lastVerifiedAt: now } : {}),
        contentHash: hashOf(data.title, data.bodyText),
        ...(sourceMeta && typeof sourceMeta === 'object' ? { sourceMeta } : {}),
        createdBy: actor?.email || actor?.name || null,
        updatedBy: actor?.email || actor?.name || null,
      },
    });
    const indexed = row.status === 'published' ? await this.indexArticle(row) : null;
    const similarTitles = await this.similarTitles(workspaceId, row.title, row.id);
    return { ...articleView(indexed || row), warnings: { similarTitles } };
  }

  async update(workspaceId, id, input, actor = null) {
    const existing = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) } }))
      .catch(() => null);
    if (!existing) throw new NotFoundError('Article not found');
    assertEditable(existing);
    const data = normalizeInput(input, { partial: true });
    const title = data.title ?? existing.title;
    const bodyText = data.bodyText ?? existing.bodyText;
    const status = data.status ?? existing.status;
    if (status === 'published' && !bodyText) throw new ValidationError('A published article needs a body');
    const contentHash = hashOf(title, bodyText);
    const contentChanged = contentHash !== existing.contentHash;
    const publishing = status === 'published' && existing.status !== 'published';
    const row = await prisma.knowledgeArticle.update({
      where: { id: existing.id },
      data: {
        ...data,
        contentHash,
        // Publishing counts as verifying: someone just stood behind it.
        ...(publishing ? { lastVerifiedAt: new Date() } : {}),
        // Stale vectors are worse than none: a changed body re-indexes below.
        ...(contentChanged ? { embedding: [], sections: [] } : {}),
        updatedBy: actor?.email || actor?.name || null,
      },
    });
    const hasSections = Array.isArray(row.sections) && row.sections.length > 0;
    const needsIndex = row.status === 'published' && (contentChanged || !hasSections || !(row.embedding || []).length);
    const indexed = needsIndex ? await this.indexArticle(row) : null;
    const similarTitles = await this.similarTitles(workspaceId, row.title, row.id);
    return { ...articleView(indexed || row), warnings: { similarTitles } };
  }

  /** "Mark as verified": someone checked it is still right today. */
  async verify(workspaceId, id, actor = null) {
    const existing = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) }, select: { id: true, source: true } }))
      .catch(() => null);
    if (!existing) throw new NotFoundError('Article not found');
    assertEditable(existing);
    const row = await prisma.knowledgeArticle.update({
      where: { id: existing.id },
      data: { lastVerifiedAt: new Date(), updatedBy: actor?.email || actor?.name || null },
    });
    return articleView(row);
  }

  /**
   * Published articles whose title is nearly the same (normalized token
   * overlap >= DUPLICATE_TITLE_OVERLAP) — a likely duplicate procedure. Used
   * as a non-blocking warning after save. Never throws.
   */
  async similarTitles(workspaceId, title, excludeId = null) {
    if (!titleTokens(title).length) return [];
    const rows = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findMany({
        where: { workspaceId: Number(workspaceId), status: 'published', ...(excludeId ? { id: { not: Number(excludeId) } } : {}) },
        select: { id: true, title: true },
        take: 2000,
      }))
      .catch(() => []);
    return (rows || [])
      .filter((r) => r.id !== Number(excludeId))
      .map((r) => ({ id: r.id, title: r.title, overlap: Math.round(titleOverlap(title, r.title) * 100) / 100 }))
      .filter((r) => r.overlap >= DUPLICATE_TITLE_OVERLAP)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5);
  }

  /**
   * "Delete" archives (25 Sep 2026 audit): the row stays so past Auto-help
   * runs keep resolving their article:<id> sources, but an archived article is
   * out of search, out of the default list and never quoted again.
   */
  async remove(workspaceId, id, actor = null) {
    const existing = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findFirst({ where: { id: Number(id), workspaceId: Number(workspaceId) }, select: { id: true, status: true, source: true, sourceMeta: true } }))
      .catch(() => null);
    if (!existing) throw new NotFoundError('Article not found');
    if (existing.status !== 'archived') {
      await prisma.knowledgeArticle.update({
        where: { id: existing.id },
        data: {
          status: 'archived',
          updatedBy: actor?.email || actor?.name || null,
          // An imported FreshService article archived here stays archived:
          // the nightly import does not bring it back.
          ...(existing.source === 'fs_solution'
            ? { sourceMeta: { ...(existing.sourceMeta && typeof existing.sourceMeta === 'object' ? existing.sourceMeta : {}), archivedInTp: true } }
            : {}),
        },
      });
    }
    return { id: existing.id, archived: true, status: 'archived' };
  }

  /**
   * Index one article: split it into sections (always) and embed the whole
   * article plus each section (when embedding is configured). Never throws;
   * returns the updated row, or null when nothing could be written. An
   * embedding failure keeps the sections keyword-only.
   */
  async indexArticle(row) {
    try {
      const split = splitArticleSections(row.bodyHtml || '').slice(0, MAX_SECTIONS);
      let articleVec = null;
      let sectionVecs = [];
      if (isEmbeddingConfigured()) {
        try {
          const texts = [
            `${row.title}\n${row.bodyText || ''}`.slice(0, EMBED_CHARS).trim(),
            ...split.map((sec) => `${row.title}${sec.heading ? ` - ${sec.heading}` : ''}\n${sec.text}`.slice(0, EMBED_CHARS)),
          ];
          const vectors = (await embedQueryTexts(texts)) || [];
          articleVec = vectors[0]?.length ? vectors[0] : null;
          sectionVecs = vectors.slice(1);
        } catch (err) {
          logger.warn(`Knowledge article ${row?.id} embedding failed (keyword search still works): ${err.message}`);
        }
      }
      const sections = split.map((sec, i) => ({
        heading: sec.heading,
        text: sec.text,
        embedding: Array.isArray(sectionVecs[i]) && sectionVecs[i].length ? sectionVecs[i] : [],
      }));
      return await prisma.knowledgeArticle.update({
        where: { id: row.id },
        data: { sections, ...(articleVec ? { embedding: articleVec } : {}) },
      });
    } catch (err) {
      logger.warn(`Knowledge article ${row?.id} indexing failed (keyword search still works): ${err.message}`);
      return null;
    }
  }

  /** Back-compat name. */
  async embedArticle(row) {
    return this.indexArticle(row);
  }

  /**
   * Hybrid search over PUBLISHED articles of one workspace (drafts and
   * archived are never searchable; there is no status option on purpose).
   *
   * Bounded, and never silently capped (25 Sep 2026 audit):
   *  1. Keyword candidates: a SQL prefilter (title/body ILIKE any of the top
   *     query words, or a tag equal to one) - up to KEYWORD_POOL rows, newest
   *     first, selecting only the columns scoring needs (no vectors).
   *  2. Semantic candidates (only when a query vector exists): the stored
   *     vectors are paged by id, VECTOR_PAGE at a time, up to VECTOR_SCAN_MAX,
   *     and the best SEMANTIC_SHORTLIST by cosine are kept. A workspace past
   *     the scan cap logs a warning instead of quietly dropping rows.
   *  3. Union ranked at article level; the best SECTION_POOL candidates have
   *     their sections read and each is scored by its BEST section (hybrid
   *     keyword + that section's embedding) - the hit carries that section.
   *  4. Category nudge; review-overdue articles x STALE_FACTOR (stale: true);
   *     floor.
   *
   * @param {object} [options]
   * @param {number[]|null} [options.queryVector] a precomputed query embedding
   *   (the runner embeds the ticket once for articles and solutions; null =
   *   keyword only, undefined = embed here when configured).
   * @returns {Promise<Array<{id,title,snippet,tags,categoryId,subcategoryId,score,matchedOn}>>}
   */
  async search(workspaceId, query, {
    limit = 5, tags = null, categoryId = null, subcategoryId = null, minScore = RELEVANCE_FLOOR, queryVector,
  } = {}) {
    const text = String(query || '').trim().slice(0, 4000);
    if (!text) return [];
    const ws = Number(workspaceId);
    const base = { workspaceId: ws, status: 'published' };
    const tagList = cleanTags(tags);
    if (tagList.length) base.tags = { hasSome: tagList };
    const tokens = queryTokens(text);

    let queryVec = Array.isArray(queryVector) && queryVector.length ? queryVector : null;
    if (queryVector === undefined && isEmbeddingConfigured()) {
      try {
        [queryVec] = (await embedQueryTexts([text])) || [];
      } catch (err) {
        logger.warn(`Knowledge query embedding failed - keyword only (${err.message})`);
        queryVec = null;
      }
    }

    const sqlTokens = tokens.slice(0, KEYWORD_SQL_TOKENS);
    const [keywordRows, cosById] = await Promise.all([
      sqlTokens.length ? Promise.resolve().then(() => prisma.knowledgeArticle.findMany({
        where: {
          ...base,
          OR: [
            ...sqlTokens.flatMap((t) => [
              { title: { contains: t, mode: 'insensitive' } },
              { bodyText: { contains: t, mode: 'insensitive' } },
            ]),
            // Topics are stored as typed ("VPN", "Bluebeam"); the tokens are
            // lower case, and a Postgres array match is exact (30 Sep 2026).
            { tags: { hasSome: [...new Set(sqlTokens.flatMap((t) => [t, t.toUpperCase(), t.charAt(0).toUpperCase() + t.slice(1)]))] } },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: KEYWORD_POOL,
        select: SEARCH_SELECT,
      })).catch((err) => {
        logger.warn(`Knowledge keyword search failed (ws ${ws}): ${err.message}`);
        return [];
      }) : [],
      queryVec ? this._semanticScan(base, queryVec) : new Map(),
    ]);
    if (keywordRows.length >= KEYWORD_POOL) {
      logger.warn(`Knowledge search (ws ${ws}): keyword prefilter hit its ${KEYWORD_POOL}-row bound; semantic ranking still covers the rest`);
    }

    const rows = new Map(keywordRows.map((r) => [r.id, r]));
    const missing = [...cosById.keys()].filter((id) => !rows.has(id));
    if (missing.length) {
      const extra = await Promise.resolve()
        .then(() => prisma.knowledgeArticle.findMany({ where: { ...base, id: { in: missing } }, select: SEARCH_SELECT }))
        .catch(() => []);
      for (const r of extra) rows.set(r.id, r);
    }
    if (!rows.size) return [];

    // Article-level pre-rank, then section-level scoring for the best few.
    const pre = [...rows.values()]
      .map((r) => ({ r, s: hybridScore({ cosine: cosById.has(r.id) ? cosById.get(r.id) : null, keyword: keywordScore(tokens, r) }) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, SECTION_POOL);
    const sectionRows = await Promise.resolve()
      .then(() => prisma.knowledgeArticle.findMany({ where: { ...base, id: { in: pre.map((x) => x.r.id) } }, select: { id: true, sections: true } }))
      .catch(() => []);
    const sectionsById = new Map((sectionRows || []).map((x) => [x.id, Array.isArray(x.sections) ? x.sections : null]));

    const now = Date.now();
    const hits = [];
    for (const { r } of pre) {
      const articleCos = cosById.has(r.id) ? cosById.get(r.id) : null;
      const sections = sectionsById.get(r.id)?.length ? sectionsById.get(r.id) : [{ heading: '', text: r.bodyText || '', embedding: [] }];
      let best = null;
      sections.forEach((sec, index) => {
        const kw = keywordScore(tokens, { title: `${r.title} ${sec.heading || ''}`, bodyText: sec.text || '', tags: r.tags });
        const own = queryVec && Array.isArray(sec.embedding) && sec.embedding.length ? cosineSimilarity(queryVec, sec.embedding) : null;
        const cos = own ?? articleCos;
        const score = hybridScore({ cosine: cos, keyword: kw });
        if (!best || score > best.score) best = { score, index, sec, kw, cos };
      });
      let score = best.score;
      // Articles in the ticket's own category are preferred (30 Sep 2026:
      // +0.12 / +0.08, was +0.05 / +0.03, too small to change the order);
      // every published article can still be found.
      if (subcategoryId && r.subcategoryId === Number(subcategoryId)) score += CATEGORY_BOOST.subcategory;
      else if (categoryId && r.categoryId === Number(categoryId)) score += CATEGORY_BOOST.category;
      const stale = isReviewOverdue({ ...r, status: 'published' }, now);
      if (stale) score *= STALE_FACTOR;
      score = Math.min(1, score);
      if (score < minScore) continue;
      const sectionText = String(best.sec.text || '');
      hits.push({
        id: r.id,
        title: r.title,
        snippet: snippetOf(sectionText || r.bodyText),
        tags: r.tags || [],
        categoryId: r.categoryId,
        subcategoryId: r.subcategoryId,
        score: Math.round(score * 1000) / 1000,
        matchedOn: best.cos === null || best.cos === undefined ? 'keyword' : (best.kw > 0 ? 'semantic+keyword' : 'semantic'),
        section: {
          index: best.index,
          heading: best.sec.heading || '',
          text: sectionText.length > SECTION_EXCERPT ? `${sectionText.slice(0, SECTION_EXCERPT - 1)}…` : sectionText,
        },
        stale,
        needsReview: stale,
        lastVerifiedAt: r.lastVerifiedAt || null,
        reviewDueAt: reviewDueAt(r),
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.min(Math.max(Number(limit) || 5, 1), 20));
  }

  /** Paged cosine scan over stored vectors: Map(id -> cosine) of the best SEMANTIC_SHORTLIST. */
  async _semanticScan(base, queryVec) {
    const scored = [];
    let cursor = 0;
    let scanned = 0;
    try {
      while (scanned < VECTOR_SCAN_MAX) {
        const page = await prisma.knowledgeArticle.findMany({
          where: { ...base, id: { gt: cursor } },
          orderBy: { id: 'asc' },
          take: VECTOR_PAGE,
          select: { id: true, embedding: true },
        });
        if (!page?.length) break;
        for (const r of page) {
          if ((r.embedding || []).length) scored.push({ id: r.id, cos: cosineSimilarity(queryVec, r.embedding) });
        }
        scanned += page.length;
        cursor = page[page.length - 1].id;
        if (page.length < VECTOR_PAGE) break;
      }
      if (scanned >= VECTOR_SCAN_MAX) {
        logger.warn(`Knowledge search (ws ${base.workspaceId}): semantic scan stopped at ${VECTOR_SCAN_MAX} articles - move to pgvector`);
      }
    } catch (err) {
      logger.warn(`Knowledge semantic scan failed - keyword only (${err.message})`);
      return new Map();
    }
    scored.sort((a, b) => b.cos - a.cos);
    return new Map(scored.slice(0, SEMANTIC_SHORTLIST).map((x) => [x.id, x.cos]));
  }
}

const knowledgeArticleService = new KnowledgeArticleService();
export default knowledgeArticleService;
export { KnowledgeArticleService };
