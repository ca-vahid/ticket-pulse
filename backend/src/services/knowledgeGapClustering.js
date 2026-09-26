/**
 * Greedy clustering for the Knowledge gap finder (Auto-help P1). Pure — no
 * I/O — so the thresholds are unit-tested (tests/knowledgeGapClustering.test.js).
 *
 * Items carry either a dense embedding (256-d text-embedding-3-small of the
 * ticket's gist: subject + the start of the cleaned description, CENTERED by
 * centerVectors) or, when embeddings are not configured, a sparse TF-IDF
 * keyword vector (tfidfVectors). Each item joins the
 * cluster whose centroid it is most similar to when that similarity reaches
 * the threshold, else it starts a new cluster; a merge pass then joins
 * clusters whose centroids ended up close. Newest items go first so a
 * cluster's seed is recent demand.
 *
 * Tuning (26 Sep 2026, 240 local IT tickets: 80 each from Software & Apps,
 * Password/MFA & access, Mobile & roaming; gist embeddings): RAW cosine is
 * useless here — every IT ticket gist sits near the same "IT request"
 * direction (same-category pairs p50 0.47 / p90 0.62, different-category
 * p50 0.42 / p90 0.56), and a greedy centroid soaks up everything (one
 * 66-ticket cluster at 0.60). Mean-CENTERING the vectors first (subtract the
 * pool's mean direction, re-normalise) spreads pairs around 0 (p50 -0.03,
 * p99 0.39-0.66) and the clusters become single requests: at 0.40, e.g.
 * "OpenGround access" (11), "GitHub access" (5), "Global Mapper licence" (4),
 * "US / Europe roaming" (7), "Failed to add Teams number" (5). 0.35 started
 * gluing unrelated pairs ("Timesheet issues" + "Email warning"); 0.45 split
 * the OpenGround and Global Mapper requests. The keyword fallback uses TF-IDF
 * (subject words count double, words in >30 % of the pool dropped); raw
 * counts drift like raw cosine, TF-IDF at 0.20 matched the embedding clusters
 * on the same tickets closely.
 */
import { queryTokens } from './knowledgeArticleService.js';
import { scrubPii } from '../utils/piiScrubber.js';

export const EMBED_THRESHOLD = 0.4; // on mean-centered vectors (centerVectors)
export const KEYWORD_THRESHOLD = 0.2; // on TF-IDF vectors (tfidfVectors)
export const MAX_CLUSTERS = 300;
/** Merge sweeps after the greedy pass (each O(k²) over at most MAX_CLUSTERS clusters). */
export const MAX_MERGE_SWEEPS = 4;

// Words every IT ticket shares: they would glue unrelated tickets together
// in the keyword fallback and make poor cluster labels.
const GENERIC = new Set([
  'issue', 'issues', 'problem', 'problems', 'help', 'request', 'requests', 'ticket', 'please', 'unable', 'cannot', 'can\'t',
  'working', 'work', 'works', 'error', 'errors', 'user', 'users', 'new', 'get', 'set', 'use', 'using', 'used', 'able', 'today',
  'thanks', 'thank', 'regards', 'hello', 'morning', 'afternoon', 'team', 'support', 'bgc', 'computer', 'laptop', 'access',
  'fwd', 'fw', 'external', 'urgent', 'asap', 'also', 'still', 'again', 'since', 'just', 'like', 'know', 'let', 'see', 'one',
  // Signatures, inline images and mail furniture.
  'engineering', 'engineer', 'cid', 'image', 'png', 'jpg', 'jpeg', 'gif', 'sent', 'email', 'e-mail', 'phone', 'mobile', 'cell',
  'office', 'direct', 'tel', 'fax', 'www', 'http', 'https', 'mailto', 'apologize', 'apologies', 'sorry', 'kind', 'best', 'cheers',
  'eng', 'p.eng', 'peng', 'ceng', 'cpeng', 'eit', 'geo', 'p.geo', 'pgeo', 'msc', 'bsc', 'phd', 'mba', 'inc', 'ltd', 'llc',
  'confidential', 'intended', 'recipient', 'message', 'attached', 'attachment', 'below', 'following', 'would', 'could',
  // Everyday English that says nothing about the request.
  'she', 'her', 'hers', 'him', 'his', 'they', 'them', 'their', 'been', 'being', 'because', 'approximately', 'about', 'after',
  'before', 'some', 'any', 'all', 'more', 'most', 'much', 'many', 'very', 'really', 'which', 'while', 'there', 'here', 'then',
  'than', 'these', 'those', 'this', 'that', 'what', 'when', 'where', 'who', 'why', 'how', 'our', 'your', 'you', 'yours',
  'have', 'has', 'had', 'does', 'did', 'done', 'doing', 'will', 'shall', 'should', 'might', 'must', 'can', 'may', 'able',
  'into', 'onto', 'from', 'with', 'without', 'within', 'for', 'and', 'but', 'not', 'yet', 'was', 'were', 'are', 'its',
  'week', 'weeks', 'day', 'days', 'time', 'times', 'today', 'tomorrow', 'yesterday', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'contacted', 'contact', 'regarding', 'hope', 'hoping', 'wondering', 'looking', 'trying', 'tried',
  // What the PII scrubber leaves behind ("the requester", "[phone removed]").
  'requester', 'person', 'agent', 'removed', 'previous',
]);

/**
 * Words that describe a request, not mail noise: starts with a letter, no
 * e-mail / domain / decimal dot, no GUID or phone-like digit runs.
 */
export function isLabelWord(w) {
  const s = String(w || '').toLowerCase();
  if (s.length < 3 || s.length > 24 || GENERIC.has(s)) return false;
  if (!/^[a-z]/.test(s) || s.includes('@') || /\.[a-z0-9]/.test(s)) return false;
  if (/\d{3,}/.test(s) || /^[0-9a-f]{6,}-/.test(s) || (s.match(/\d/g) || []).length > 2) return false;
  return true;
}

export function isGenericWord(w) {
  return GENERIC.has(String(w || '').toLowerCase());
}

/** Unit-length copy of a dense vector (null for empty / zero). */
export function normalize(vec) {
  if (!Array.isArray(vec) || !vec.length) return null;
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n);
  if (!n) return null;
  return vec.map((x) => x / n);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/** Sparse keyword vector: token -> count (generic words dropped). */
export function keywordVector(text) {
  const out = new Map();
  for (const tok of queryTokens(text)) {
    if (!isLabelWord(tok)) continue;
    out.set(tok, (out.get(tok) || 0) + 1);
  }
  return out;
}

export function sparseCosine(a, b) {
  if (!a?.size || !b?.size) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    if (b.has(k)) d += v * b.get(k);
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

function denseSpace() {
  return {
    sim: (a, b) => dot(a, b), // both unit length
    zero: (v) => new Array(v.length).fill(0),
    add: (acc, v) => { for (let i = 0; i < v.length; i += 1) acc[i] += v[i]; return acc; },
    centroid: (sum) => normalize(sum) || sum,
  };
}

function sparseSpace() {
  return {
    sim: sparseCosine,
    zero: () => new Map(),
    add: (acc, v) => { for (const [k, x] of v) acc.set(k, (acc.get(k) || 0) + x); return acc; },
    centroid: (sum) => sum,
  };
}

/**
 * @param {Array<{id: any, vec: number[]|Map<string,number>, at?: Date|string|number}>} items
 * @param {{ threshold?: number, mode?: 'dense'|'sparse', maxClusters?: number }} [options]
 * @returns {Array<{ members: object[], centroid: any }>} biggest first, then most recent
 */
export function greedyCluster(items, { threshold = null, mode = 'dense', maxClusters = MAX_CLUSTERS } = {}) {
  const space = mode === 'sparse' ? sparseSpace() : denseSpace();
  const bar = threshold ?? (mode === 'sparse' ? KEYWORD_THRESHOLD : EMBED_THRESHOLD);
  const ready = (items || [])
    .map((it) => ({ ...it, vec: mode === 'sparse' ? it.vec : normalize(it.vec) }))
    .filter((it) => (mode === 'sparse' ? it.vec instanceof Map && it.vec.size : Array.isArray(it.vec)))
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const clusters = [];
  for (const it of ready) {
    let best = null;
    let bestSim = -1;
    for (const c of clusters) {
      const s = space.sim(it.vec, c.centroid);
      if (s > bestSim) { bestSim = s; best = c; }
    }
    if (best && bestSim >= bar) {
      best.members.push(it);
      best.sum = space.add(best.sum, it.vec);
      best.centroid = space.centroid(best.sum);
    } else if (clusters.length < maxClusters) {
      const sum = space.add(space.zero(it.vec), it.vec);
      clusters.push({ members: [it], sum, centroid: space.centroid(sum) });
    } else if (best) {
      // Out of room: the nearest cluster takes it rather than dropping demand.
      best.members.push(it);
      best.sum = space.add(best.sum, it.vec);
      best.centroid = space.centroid(best.sum);
    }
  }
  // Merge pass: clusters whose centroids drifted together. One sweep is
  // O(k²): cluster i absorbs every later j close to its (updated) centroid,
  // without restarting the scan after each merge (that restart made the old
  // pass O(k³)). A few sweeps catch chains; k <= maxClusters bounds it.
  let live = clusters;
  for (let sweep = 0; sweep < MAX_MERGE_SWEEPS; sweep += 1) {
    let merged = false;
    const gone = new Set();
    for (let i = 0; i < live.length; i += 1) {
      if (gone.has(i)) continue;
      const ci = live[i];
      for (let j = i + 1; j < live.length; j += 1) {
        if (gone.has(j)) continue;
        const cj = live[j];
        if (space.sim(ci.centroid, cj.centroid) >= bar) {
          ci.members.push(...cj.members);
          ci.sum = space.add(ci.sum, cj.sum);
          ci.centroid = space.centroid(ci.sum);
          gone.add(j);
          merged = true;
        }
      }
    }
    live = live.filter((_, k) => !gone.has(k));
    if (!merged) break;
  }
  return live
    .map((c) => ({
      members: c.members.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)),
      centroid: c.centroid,
    }))
    .sort((a, b) => (b.members.length - a.members.length) || (new Date(b.members[0]?.at || 0) - new Date(a.members[0]?.at || 0)));
}

/**
 * Mean-centering: subtract the mean direction of `vectors` + `background`
 * (a sample of ordinary recent tickets, so a pool of two gap tickets is not
 * centered on itself) and re-normalise. Returns unit vectors (null kept).
 */
export function centerVectors(vectors, background = []) {
  const unit = [...vectors, ...background].map(normalize).filter(Boolean);
  if (unit.length < 2) return vectors.map(normalize);
  const mean = new Array(unit[0].length).fill(0);
  for (const v of unit) for (let i = 0; i < v.length; i += 1) mean[i] += v[i] / unit.length;
  return vectors.map((v) => {
    const u = normalize(v);
    return u ? normalize(u.map((x, i) => x - mean[i])) : null;
  });
}

/**
 * TF-IDF keyword vectors for the fallback: subject words count double; words
 * in more than 30 % of the documents (every ticket says "install") are
 * dropped. docs: [{ subject, body }].
 */
export function tfidfVectors(docs) {
  const raw = (docs || []).map((d) => {
    const v = keywordVector(d?.body || '');
    for (const [k, c] of keywordVector(cleanSubject(d?.subject || ''))) v.set(k, (v.get(k) || 0) + 2 * c);
    return v;
  });
  const df = new Map();
  for (const v of raw) for (const k of v.keys()) df.set(k, (df.get(k) || 0) + 1);
  const n = Math.max(1, raw.length);
  const cap = n >= 10 ? n * 0.3 : Infinity;
  return raw.map((v) => new Map([...v]
    .filter(([k]) => df.get(k) <= cap)
    .map(([k, c]) => [k, c * Math.log(1 + n / df.get(k))])));
}

/** The member closest to the centroid (the cluster's "typical" ticket). */
export function medoid(cluster, mode = 'dense') {
  const sim = mode === 'sparse' ? sparseCosine : (a, b) => dot(a, b);
  let best = cluster.members[0];
  let bestSim = -Infinity;
  for (const m of cluster.members) {
    const s = sim(m.vec, cluster.centroid);
    if (s > bestSim) { bestSim = s; best = m; }
  }
  return best;
}

/**
 * Words that describe this cluster and not the rest: in-cluster document
 * frequency, damped by how common the word is across every gap ticket.
 * Words in only one member count only for single-ticket clusters.
 */
export function clusterKeywords(memberTexts, allTexts, { limit = 4 } = {}) {
  const docFreq = (texts) => {
    const df = new Map();
    for (const t of texts) for (const w of new Set(keywordVector(t).keys())) df.set(w, (df.get(w) || 0) + 1);
    return df;
  };
  if (memberTexts.length < 2) return []; // one ticket's rarest words are noise, not a topic
  const inside = docFreq(memberTexts);
  const overall = docFreq(allTexts);
  const n = Math.max(1, allTexts.length);
  const minDf = memberTexts.length >= 3 ? 2 : 1;
  return [...inside.entries()]
    .filter(([, df]) => df >= minDf)
    .map(([w, df]) => ({ w, score: (df / memberTexts.length) * Math.log(1 + n / (overall.get(w) || 1)) }))
    .sort((a, b) => (b.score - a.score) || a.w.localeCompare(b.w))
    .slice(0, limit)
    .map((x) => x.w);
}

/**
 * A gap cluster's title, safe to show to everyone: the typical ticket's
 * subject, cleaned and PII-scrubbed (the tickets' requesters by name, plus
 * the scrubber's rules for names nobody passed in: "NIck stone - EUROPE move"
 * -> "EUROPE move"), with what the scrubber put in their place dropped. Falls
 * back to the cluster's keywords when nothing meaningful is left.
 */
export function gapTitle(subject, { people = [], keywords = [] } = {}) {
  let scrubbed = scrubPii(cleanSubject(subject), { people: (people || []).filter(Boolean).map((p) => ({ ...p, role: 'person' })) })
    .replace(/\b(?:the (?:requester|agent|person)(?:'s)?|a previous ticket)\b/gi, ' ')
    .replace(/\[(?:e-mail|phone|IP|address|link) removed\]|\[removed\]/g, ' ')
    .replace(/\(\s*[,;:]?\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // What the removals leave dangling: "Laptop for", "- Europe move", "a - - b".
  for (let i = 0; i < 3; i += 1) {
    scrubbed = scrubbed
      .replace(/(?:^|\s)(?:for|from|by|with|to|of|and|re|cc)\s*$/i, '')
      .replace(/^\s*(?:for|from|by|with|to|of|and|cc)\s+/i, '')
      .replace(/\s([-–—|:,/])(?:\s*[-–—|:,/])+\s/g, ' $1 ')
      .replace(/^[\s\-–—|:,/.]+|[\s\-–—|:,/]+$/g, '')
      .trim();
  }
  const words = scrubbed.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (words.length >= 3) return scrubbed.slice(0, 160);
  return (keywords || []).join(' · ') || 'Untitled';
}

/** "RE: FW: [External] Install Revit" -> "Install Revit". */
export function cleanSubject(subject) {
  return String(subject || '')
    .replace(/^\s*(?:(?:re|fw|fwd|aw|sv|tr)\s*:\s*|\[[^\]]{1,20}\]\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
