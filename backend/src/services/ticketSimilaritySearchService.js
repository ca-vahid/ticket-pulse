/**
 * "Is there already a ticket for this?" — hybrid similarity search for a
 * piece of free text (ContinuIT search request, 23 Sep 2026).
 *
 *   semantic  the stored 256-dim text-embedding-3-small vectors (one per
 *             ticket, ticketEmbeddingService) against the embedded query
 *   keyword   Postgres full-text over subject + description (the
 *             tickets_fts_idx expression), for exact names and for tickets
 *             that have no embedding yet
 *   reference TP-1234 / #241406 in the text → that ticket, score 1
 *
 * The score is CALIBRATED, not raw cosine. With 256-dim vectors every IT
 * ticket sounds alike (unrelated IT phrases reach 0.55–0.70 raw cosine), so a
 * raw threshold cannot separate "same work" from "same kind of work". The
 * blend below was fitted on 165 meeting-style queries against the 588 open IT
 * tickets (prod, 23 Sep 2026; logistic, class-balanced, cross-validated on
 * five random halvings): how far the ticket stands out from the rest of the
 * pool (z), how far it leads the runner-up (gap), and whether the text and
 * the ticket name the same office or different offices matter as much as the
 * cosine itself. Held-out result: score ≥ 0.7 flags ~75 % of true matches in
 * the top 3 and ~10 % of unrelated phrases; ≥ 0.6 flags ~80 % / ~20 %.
 * Change the weights only with a fresh calibration and a new SCORE_MODEL
 * version — integrators store thresholds against it.
 *
 * Cost: one embeddings call per request (batch = one call for all texts),
 * cached per text; candidate vectors are cached in process and refreshed
 * incrementally, so a warm search is a few thousand dot products plus two
 * indexed queries.
 */
import crypto from 'node:crypto';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import statusService from './statusService.js';
import { EMBEDDING_MODEL, embedQueryTexts, isEmbeddingConfigured } from './ticketEmbeddingService.js';
import { OFFICE_LOCATIONS } from '../config/officeLocations.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { resolvePublicBaseUrl } from '../utils/publicBaseUrl.js';

export const SCORE_MODEL = Object.freeze({
  // 2026-09-23b: office agreement alone can no longer carry a score over
  // "likely" (ContinuIT acceptance: Kelowna UPS batteries vs Kelowna
  // firewall scored 0.83). On the calibration set this took unrelated
  // phrases >= 0.7 from 5/45 to 1/45 for 90 -> 88/120 true matches; the 0.6
  // line is unchanged.
  // 2026-09-23c: a ticket's office is its MAIN office — subject, the
  // continuit_office field and the requester's office; the description counts
  // only when those name none. The Kelowna firewall ticket discusses Kamloops
  // at length, so "Kamloops firewall visit" matched it as same-office (0.99).
  // Neutral on the calibration set (same counts at 0.6 and 0.7).
  version: '2026-09-23c',
  weights: Object.freeze({ cosine: 4.4, z: 1.91, gap: 8.72, officeMatch: 0.54, officeConflict: -1.38 }),
  bias: -8.43,
  thresholds: Object.freeze({ likely: 0.7, possible: 0.6 }),
});

export const LIMITS = Object.freeze({
  maxLimit: 20, defaultLimit: 5, defaultMinScore: 0.5, maxBatch: 20,
  maxTextChars: 4000, minTextChars: 3, maxCandidates: 5000,
});

const SEMANTIC_SHORTLIST = 30; // raw-cosine leaders that get the full feature treatment
const KEYWORD_TAKE = 15;
const REFRESH_EVERY_MS = 60 * 1000;
const QUERY_CACHE_MAX = 1000;

const DEFAULT_BASES = ['open', 'pending'];
const BASES = ['open', 'pending', 'resolved', 'closed'];

// ------------------------------------------------------------------ helpers

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function normalize(vec) {
  const out = new Float32Array(vec.length);
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

const OFFICE_NAMES = Object.keys(OFFICE_LOCATIONS).filter((n) => n.toLowerCase() !== 'default');
const OFFICE_PATTERNS = OFFICE_NAMES.map((name) => [name, new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)]);

/** Office names mentioned in a piece of text (lower-cased match, canonical names out). */
export function officesIn(text) {
  const s = String(text || '').toLowerCase();
  const found = new Set();
  if (!s) return found;
  for (const [name, re] of OFFICE_PATTERNS) if (re.test(s)) found.add(name);
  return found;
}

/** Tokens that name one specific thing: letters and digits mixed (BGC1, A82, CGY-FS01, SR-4412). */
export function identifierTokens(text) {
  const out = new Set();
  for (const raw of String(text || '').match(/[A-Za-z0-9][A-Za-z0-9-]{1,30}/g) || []) {
    const t = raw.replace(/-+$/, '');
    if (t.length >= 3 && /[A-Za-z]/.test(t) && /\d/.test(t) && !/^TP-\d+$/i.test(t)) out.add(t.toLowerCase());
  }
  return out;
}

/** TP-1234 → native numbers; #241406 → FreshService ids. */
export function referencesIn(text) {
  const s = String(text || '');
  const native = [...s.matchAll(/\bTP-(\d{1,7})\b/gi)].map((m) => Number(m[1]));
  const fs = [...s.matchAll(/(?:^|[^\w])#(\d{4,12})\b/g)].map((m) => m[1]);
  return { native: [...new Set(native)], freshservice: [...new Set(fs)] };
}

const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'they', 'them', 'their', 'there', 'about', 'into', 'once', 'when', 'what', 'which', 'would', 'should', 'could', 'need', 'needs', 'make', 'sure', 'also', 'some', 'more', 'than', 'then', 'just', 'like', 'next', 'week', 'before', 'after', 'we\'ll', 'let\'s', 'ticket', 'please']);

/** Full-text query: OR of the significant words (websearch syntax). */
export function keywordQuery(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 16).join(' or ');
}

/**
 * The calibrated semantic score for one candidate. Inputs are what the
 * calibration measured: cosine, z against the candidate pool, lead over the
 * best OTHER candidate, and office agreement.
 */
export function semanticScore({ cosine, z, gap, officeMatch = false, officeConflict = false }) {
  const w = SCORE_MODEL.weights;
  const base = w.cosine * cosine + w.z * z + w.gap * Math.max(gap, -0.2)
    + (officeConflict ? w.officeConflict : 0) + SCORE_MODEL.bias;
  if (officeMatch) {
    // Same office may lift a score, but never across "likely" on its own.
    const withOffice = sigmoid(base + w.officeMatch);
    const without = sigmoid(base);
    return without < SCORE_MODEL.thresholds.likely ? Math.min(withOffice, SCORE_MODEL.thresholds.likely - 0.01) : withOffice;
  }
  const logit = base;
  return sigmoid(logit);
}

/** Combine the halves into the published score + matchedOn. */
export function blendScore({ semantic = null, keyword = 0, identifierHit = false, exactRef = false, requesterMatch = false }) {
  if (exactRef) return { score: 1, matchedOn: 'keyword' };
  let score;
  let matchedOn;
  const kwHit = keyword > 0 || identifierHit;
  if (semantic === null) {
    // No vector for this ticket (yet): keyword alone, capped below "likely".
    score = Math.min(0.6, 0.3 + 0.6 * keyword + (identifierHit ? 0.15 : 0));
    matchedOn = 'keyword';
  } else {
    score = semantic + (1 - semantic) * 0.15 * Math.min(1, keyword * 2);
    if (identifierHit) score = Math.max(score, 0.75);
    matchedOn = kwHit ? 'both' : 'semantic';
  }
  if (requesterMatch) score = Math.min(0.99, score + 0.05);
  return { score: Math.round(score * 1000) / 1000, matchedOn };
}

// ------------------------------------------------------------ vector cache

class VectorCache {
  constructor() { this.byWorkspace = new Map(); }

  _ws(workspaceId) {
    let c = this.byWorkspace.get(workspaceId);
    if (!c) {
      c = { vectors: new Map(), watermark: new Date(), checkedAt: Date.now(), refreshing: null };
      this.byWorkspace.set(workspaceId, c);
    }
    return c;
  }

  /** Vectors for these ticket ids (fetching the ones not held yet), refreshed at most once a minute. */
  async get(workspaceId, ticketIds) {
    const c = this._ws(workspaceId);
    if (Date.now() - c.checkedAt > REFRESH_EVERY_MS) {
      c.refreshing = c.refreshing || this._refresh(workspaceId, c).finally(() => { c.refreshing = null; });
    }
    if (c.refreshing) await c.refreshing;
    const missing = ticketIds.filter((id) => !c.vectors.has(id));
    for (let i = 0; i < missing.length; i += 1000) {
      const rows = await prisma.ticketEmbedding.findMany({
        where: { workspaceId, ticketId: { in: missing.slice(i, i + 1000) }, model: EMBEDDING_MODEL },
        select: { ticketId: true, embedding: true },
      });
      for (const r of rows) c.vectors.set(r.ticketId, normalize(r.embedding));
      // Remember "no vector" too, so a ticket without an embedding is not re-queried every call.
      for (const id of missing.slice(i, i + 1000)) if (!c.vectors.has(id)) c.vectors.set(id, null);
    }
    const out = new Map();
    for (const id of ticketIds) {
      const v = c.vectors.get(id);
      if (v) out.set(id, v);
    }
    return out;
  }

  async _refresh(workspaceId, c) {
    const started = new Date(Date.now() - 5000); // clock-skew margin
    try {
      const rows = await prisma.ticketEmbedding.findMany({
        where: { workspaceId, updatedAt: { gt: c.watermark }, model: EMBEDDING_MODEL },
        select: { ticketId: true, embedding: true },
      });
      for (const r of rows) c.vectors.set(r.ticketId, normalize(r.embedding));
      // A ticket that had no vector may have one now.
      for (const [id, v] of c.vectors) if (v === null) c.vectors.delete(id);
      c.watermark = started;
    } catch (err) {
      logger.warn(`Similarity vector refresh failed for ws${workspaceId} (non-fatal): ${err.message}`);
    } finally {
      c.checkedAt = Date.now();
    }
  }

  clear() { this.byWorkspace.clear(); }
}

// ------------------------------------------------------------ query vectors

const queryCache = new Map();
function queryKey(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

async function embedQueries(texts) {
  const result = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = queryCache.get(queryKey(t));
    if (hit) result[i] = hit; else todo.push(i);
  });
  if (todo.length && isEmbeddingConfigured()) {
    const vecs = await embedQueryTexts(todo.map((i) => texts[i]));
    if (vecs) {
      todo.forEach((i, n) => {
        const v = normalize(vecs[n]);
        result[i] = v;
        queryCache.set(queryKey(texts[i]), v);
        if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
      });
    }
  }
  return result;
}

// ------------------------------------------------------------------ service

class TicketSimilaritySearchService {
  constructor() { this.cache = new VectorCache(); }

  /** Validate + default the shared options; throws { field, message } on bad input. */
  normalizeOptions(raw = {}) {
    const bad = (field, message) => Object.assign(new Error(message), { field, validation: true });
    const limit = raw.limit === undefined ? LIMITS.defaultLimit : Number(raw.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxLimit) throw bad('limit', `limit must be an integer 1–${LIMITS.maxLimit}`);
    const minScore = raw.minScore === undefined ? LIMITS.defaultMinScore : Number(raw.minScore);
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw bad('minScore', 'minScore must be between 0 and 1');
    let bases = raw.status === undefined ? DEFAULT_BASES : (Array.isArray(raw.status) ? raw.status : [raw.status]);
    bases = bases.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    const unknown = bases.filter((b) => !BASES.includes(b));
    if (!bases.length || unknown.length) throw bad('status', `status must be base statuses: ${BASES.join(', ')}`);
    let updatedFrom = null;
    if (raw.updatedFrom !== undefined && raw.updatedFrom !== null && raw.updatedFrom !== '') {
      updatedFrom = new Date(raw.updatedFrom);
      if (Number.isNaN(updatedFrom.getTime())) throw bad('updatedFrom', 'updatedFrom must be an ISO date or datetime');
    }
    const prefix = raw.excludeExternalRefPrefix ? String(raw.excludeExternalRefPrefix).trim().slice(0, 100) : null;
    return {
      limit, minScore, bases: [...new Set(bases)], updatedFrom,
      excludeExternalRefPrefix: prefix || null,
      requesterEmail: raw.requesterEmail ? String(raw.requesterEmail).trim().toLowerCase() : null,
      department: raw.department ? String(raw.department).trim().slice(0, 100) : null,
    };
  }

  /** Validate the texts; returns [{ key, text }]. */
  normalizeItems(items) {
    const bad = (field, message) => Object.assign(new Error(message), { field, validation: true });
    if (!Array.isArray(items) || !items.length) throw bad('items', 'Send at least one text');
    if (items.length > LIMITS.maxBatch) throw bad('items', `At most ${LIMITS.maxBatch} texts per call`);
    const seen = new Set();
    return items.map((it, i) => {
      const key = String(it?.key ?? '').trim().slice(0, 100) || String(i);
      if (seen.has(key)) throw bad(`items[${i}].key`, `Duplicate key "${key}"`);
      seen.add(key);
      const text = String(it?.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length < LIMITS.minTextChars) throw bad(`items[${i}].text`, `text must be at least ${LIMITS.minTextChars} characters`);
      return { key, text: text.slice(0, LIMITS.maxTextChars) };
    });
  }

  async _statusNames(workspaceId, bases) {
    const defs = await statusService.listStatuses(workspaceId, { includeInactive: true });
    const names = defs.filter((d) => bases.includes(String(d.baseStatus || '').toLowerCase())).map((d) => d.name);
    // Canonical labels always resolve to themselves (legacy rows).
    for (const b of bases) names.push(b.charAt(0).toUpperCase() + b.slice(1));
    return [...new Set(names)];
  }

  _candidateWhere(workspaceId, opts, statusNames) {
    return {
      workspaceId,
      isNoise: false,
      status: { in: statusNames },
      ...(opts.updatedFrom ? { updatedAt: { gte: opts.updatedFrom } } : {}),
      ...(opts.excludeExternalRefPrefix
        ? { OR: [{ externalRef: null }, { NOT: { externalRef: { startsWith: opts.excludeExternalRefPrefix } } }] }
        : {}),
    };
  }

  async _keywordHits(workspaceId, opts, statusNames, text) {
    const q = keywordQuery(text);
    if (!q || typeof prisma.$queryRawUnsafe !== 'function') return [];
    const params = [workspaceId, statusNames, q];
    let extra = '';
    if (opts.updatedFrom) { params.push(opts.updatedFrom); extra += ` AND t.updated_at >= $${params.length}`; }
    if (opts.excludeExternalRefPrefix) { params.push(`${opts.excludeExternalRefPrefix}%`); extra += ` AND (t.external_ref IS NULL OR t.external_ref NOT LIKE $${params.length})`; }
    try {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT t.id, ts_rank_cd(to_tsvector('english', coalesce(t.subject, '') || ' ' || coalesce(t.description_text, '')),
                                websearch_to_tsquery('english', $3), 32) AS r
        FROM tickets t
        WHERE t.workspace_id = $1 AND t.is_noise = false AND t.status = ANY($2)
          AND to_tsvector('english', coalesce(t.subject, '') || ' ' || coalesce(t.description_text, '')) @@ websearch_to_tsquery('english', $3)
          ${extra}
        ORDER BY r DESC LIMIT ${KEYWORD_TAKE}`, ...params);
      return rows.map((r) => ({ id: Number(r.id), r: Number(r.r) || 0 }));
    } catch (err) {
      logger.warn(`Similarity keyword query failed (non-fatal): ${err.message}`);
      return [];
    }
  }

  async _referenceHits(workspaceId, text) {
    const refs = referencesIn(text);
    if (!refs.native.length && !refs.freshservice.length) return [];
    const or = [
      ...(refs.native.length ? [{ nativeNumber: { in: refs.native } }] : []),
      ...(refs.freshservice.length ? [{ freshserviceTicketId: { in: refs.freshservice.map((s) => BigInt(s)) } }] : []),
    ];
    const rows = await prisma.ticket.findMany({ where: { workspaceId, OR: or }, select: { id: true } }).catch(() => []);
    return rows.map((r) => r.id);
  }

  /**
   * Search for each item. Returns { results: { key: [hit…] }, meta }.
   */
  async search(workspaceId, rawItems, rawOptions = {}) {
    const items = this.normalizeItems(rawItems);
    const opts = this.normalizeOptions(rawOptions);
    const started = Date.now();

    const statusNames = await this._statusNames(workspaceId, opts.bases);
    const candidates = await prisma.ticket.findMany({
      where: this._candidateWhere(workspaceId, opts, statusNames),
      orderBy: { updatedAt: 'desc' },
      take: LIMITS.maxCandidates,
      select: { id: true },
    });
    const candidateIds = candidates.map((c) => c.id);
    const truncated = candidateIds.length >= LIMITS.maxCandidates;

    const [vectors, queryVecs] = await Promise.all([
      candidateIds.length ? this.cache.get(workspaceId, candidateIds) : new Map(),
      embedQueries(items.map((i) => i.text)).catch((err) => {
        logger.warn(`Similarity query embedding failed — keyword only (${err.message})`);
        return items.map(() => null);
      }),
    ]);
    const semanticAvailable = queryVecs.some(Boolean);
    const deptOffices = officesIn(opts.department);

    // Per item: semantic shortlist + keyword + references.
    const perItem = [];
    for (let n = 0; n < items.length; n++) {
      const qv = queryVecs[n];
      let shortlist = [];
      let mean = 0;
      let sd = 1;
      if (qv && vectors.size) {
        const scored = [];
        for (const [id, v] of vectors) scored.push({ id, s: dot(qv, v) });
        mean = scored.reduce((a, b) => a + b.s, 0) / scored.length;
        sd = Math.sqrt(scored.reduce((a, b) => a + (b.s - mean) ** 2, 0) / scored.length) || 1;
        scored.sort((a, b) => b.s - a.s);
        shortlist = scored.slice(0, SEMANTIC_SHORTLIST);
      }
      perItem.push({ shortlist, mean, sd, kw: [], refIds: [] });
    }
    // Keyword + reference lookups, four items at a time: a batch of 20 ran
    // them one after another (4.3 s in ContinuIT's acceptance run). Four
    // keeps the 9-connection pool free for everyone else.
    for (let start = 0; start < items.length; start += 4) {
      await Promise.all(items.slice(start, start + 4).map(async (item, k) => {
        const [kw, refIds] = await Promise.all([
          this._keywordHits(workspaceId, opts, statusNames, item.text),
          this._referenceHits(workspaceId, item.text),
        ]);
        perItem[start + k].kw = kw;
        perItem[start + k].refIds = refIds;
      }));
    }

    // Load every ticket any item may return, once.
    const allIds = [...new Set(perItem.flatMap((p) => [...p.shortlist.map((x) => x.id), ...p.kw.map((x) => x.id), ...p.refIds]))];
    const tickets = allIds.length ? await prisma.ticket.findMany({
      where: { workspaceId, id: { in: allIds } },
      select: {
        id: true, subject: true, descriptionText: true, status: true, origin: true, nativeNumber: true,
        freshserviceTicketId: true, externalRef: true, createdAt: true, updatedAt: true, dueBy: true, customFields: true,
        requester: { select: { name: true, email: true, department: true, entraDepartment: true, entraOfficeLocation: true } },
        assignedTech: { select: { name: true, email: true } },
      },
    }) : [];
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const baseByName = new Map((await statusService.listStatuses(workspaceId, { includeInactive: true }))
      .map((d) => [d.name, String(d.baseStatus || d.name).toLowerCase()]));
    const baseUrl = resolvePublicBaseUrl({ warn: (m) => logger.warn(m) });

    const results = {};
    items.forEach((item, n) => {
      const { shortlist, mean, sd, kw, refIds } = perItem[n];
      const sById = new Map(shortlist.map((x) => [x.id, x.s]));
      const kwById = new Map(kw.map((x) => [x.id, x.r]));
      const qOffices = new Set([...officesIn(item.text), ...deptOffices]);
      const qIdents = identifierTokens(item.text);
      const ids = new Set([...shortlist.map((x) => x.id), ...kw.map((x) => x.id), ...refIds]);
      const hits = [];
      for (const id of ids) {
        const t = byId.get(id);
        if (!t) continue;
        const text = `${t.subject || ''}\n${t.descriptionText || ''}`;
        let semantic = null;
        const cosine = sById.has(id) ? sById.get(id) : (vectors.get(id) && queryVecs[n] ? dot(queryVecs[n], vectors.get(id)) : null);
        if (cosine !== null) {
          const best = shortlist[0];
          const other = best && best.id !== id ? best.s : (shortlist[1]?.s ?? cosine);
          const primary = new Set([...officesIn(t.subject), ...officesIn(t.requester?.entraOfficeLocation), ...officesIn(t.customFields?.continuit_office)]);
          const tOffices = primary.size ? primary : officesIn(t.descriptionText);
          const overlap = [...qOffices].some((o) => tOffices.has(o));
          semantic = semanticScore({
            cosine, z: (cosine - mean) / sd, gap: cosine - other,
            officeMatch: qOffices.size > 0 && overlap,
            officeConflict: qOffices.size > 0 && tOffices.size > 0 && !overlap,
          });
        }
        const lowerText = text.toLowerCase();
        const identifierHit = [...qIdents].some((tok) => lowerText.includes(tok));
        const r = kwById.get(id) || 0;
        const { score, matchedOn } = blendScore({
          semantic, keyword: r, identifierHit, exactRef: refIds.includes(id),
          requesterMatch: !!opts.requesterEmail && String(t.requester?.email || '').toLowerCase() === opts.requesterEmail,
        });
        if (score < opts.minScore) continue;
        hits.push(shapeHit(t, { score, matchedOn, baseStatus: baseByName.get(t.status) || String(t.status).toLowerCase(), baseUrl }));
      }
      hits.sort((a, b) => b.score - a.score || new Date(b.updatedAt) - new Date(a.updatedAt));
      results[item.key] = hits.slice(0, opts.limit);
    });

    return {
      results,
      meta: {
        scoreModel: SCORE_MODEL.version,
        thresholds: SCORE_MODEL.thresholds,
        semantic: semanticAvailable,
        candidates: candidateIds.length,
        embedded: vectors.size,
        truncated,
        tookMs: Date.now() - started,
      },
    };
  }
}

function snippetOf(t) {
  const s = String(t.descriptionText || '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 197)}…` : s || null;
}

function shapeHit(t, { score, matchedOn, baseStatus, baseUrl }) {
  return {
    id: t.id,
    ref: ticketDisplayRef(t),
    subject: t.subject,
    status: t.status,
    baseStatus,
    score,
    matchedOn,
    requester: t.requester ? { name: t.requester.name, email: t.requester.email } : null,
    assignee: t.assignedTech ? { name: t.assignedTech.name, email: t.assignedTech.email || null } : null,
    department: t.requester?.department || t.requester?.entraDepartment || null,
    office: t.requester?.entraOfficeLocation || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    dueBy: t.dueBy || null,
    externalRef: t.externalRef || null,
    externalReferences: t.freshserviceTicketId ? [{ system: 'FRESHSERVICE', id: String(t.freshserviceTicketId) }] : [],
    url: `${baseUrl}/tickets/${t.id}`,
    snippet: snippetOf(t),
  };
}

const ticketSimilaritySearchService = new TicketSimilaritySearchService();
export default ticketSimilaritySearchService;
export { TicketSimilaritySearchService, VectorCache };
