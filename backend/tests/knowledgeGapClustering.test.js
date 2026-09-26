/**
 * Gap clustering (Auto-help P1). Synthetic vectors reproduce the shape seen
 * on real IT ticket gists (26 Sep 2026 tuning): every ticket shares a strong
 * common "IT request" direction, and a request's paraphrases share a weaker
 * topic direction on top of it. Raw cosine then puts EVERYTHING above the
 * bar; mean-centering first separates the topics at EMBED_THRESHOLD (0.40).
 */
import {
  EMBED_THRESHOLD, KEYWORD_THRESHOLD, centerVectors, cleanSubject, clusterKeywords, greedyCluster, medoid, normalize,
  sparseCosine, tfidfVectors,
} from '../src/services/knowledgeGapClustering.js';

const DIM = 64;
// Deterministic pseudo-random numbers (LCG) so the fixture never flakes.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
}
const rand = rng(42);
const randomVec = () => Array.from({ length: DIM }, () => rand());
const COMMON = normalize(randomVec());
const TOPICS = { revit: normalize(randomVec()), vpn: normalize(randomVec()), roaming: normalize(randomVec()) };

function ticketVec(topic, { common = 2.2, topicW = 1.2, noise = 0.55 } = {}) {
  const n = normalize(randomVec());
  return COMMON.map((c, i) => common * c + topicW * TOPICS[topic][i] + noise * n[i]);
}
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

function fixture() {
  const items = [];
  let id = 1;
  for (const topic of ['revit', 'vpn', 'roaming']) {
    for (let k = 0; k < 6; k += 1) items.push({ id: id++, topic, vec: ticketVec(topic), at: new Date(2026, 8, 1 + id) });
  }
  return items;
}

describe('greedyCluster (dense)', () => {
  test('the fixture looks like real IT gists: raw cosine is high everywhere', () => {
    const items = fixture();
    const unit = items.map((x) => normalize(x.vec));
    const cross = [];
    for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) if (items[i].topic !== items[j].topic) cross.push(dot(unit[i], unit[j]));
    expect(Math.min(...cross)).toBeGreaterThan(EMBED_THRESHOLD);
  });

  test('raw vectors collapse into one cluster; centered vectors give one cluster per topic', () => {
    const items = fixture();
    const raw = greedyCluster(items);
    expect(raw).toHaveLength(1);

    const centered = centerVectors(items.map((x) => x.vec));
    const clusters = greedyCluster(items.map((x, i) => ({ ...x, vec: centered[i] })));
    expect(clusters).toHaveLength(3);
    for (const c of clusters) {
      expect(new Set(c.members.map((m) => m.topic)).size).toBe(1);
      expect(c.members).toHaveLength(6);
    }
  });

  test('centering with a background sample keeps a tiny pool from cancelling itself', () => {
    const pair = [{ id: 1, vec: ticketVec('revit') }, { id: 2, vec: ticketVec('revit') }];
    const background = [...Array(20)].map((_, i) => ticketVec(['vpn', 'roaming'][i % 2]));
    const alone = centerVectors(pair.map((p) => p.vec));
    expect(dot(alone[0], alone[1])).toBeLessThan(0); // two points centered on themselves point apart
    const withBg = centerVectors(pair.map((p) => p.vec), background);
    expect(dot(withBg[0], withBg[1])).toBeGreaterThan(EMBED_THRESHOLD);
    expect(greedyCluster(pair.map((p, i) => ({ ...p, vec: withBg[i] })))).toHaveLength(1);
  });

  test('threshold edges: a single outlier stays on its own; the merge pass joins drifted twins', () => {
    const a = normalize([1, 0, 0]);
    const b = normalize([0.8, 0.6, 0]); // cos 0.8 with a
    const c = normalize([0, 0, 1]); // unrelated
    const out = greedyCluster([{ id: 'a', vec: a, at: 3 }, { id: 'b', vec: b, at: 2 }, { id: 'c', vec: c, at: 1 }], { threshold: 0.7 });
    expect(out.map((cl) => cl.members.map((m) => m.id))).toEqual([['a', 'b'], ['c']]);
    expect(greedyCluster([{ id: 'a', vec: a }, { id: 'b', vec: b }], { threshold: 0.81 })).toHaveLength(2);
  });

  test('newest first inside a cluster, biggest cluster first; empty vectors are ignored', () => {
    const v = normalize([1, 1]);
    const out = greedyCluster([
      { id: 1, vec: v, at: '2026-09-01' }, { id: 2, vec: v, at: '2026-09-20' }, { id: 3, vec: [], at: '2026-09-21' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.id)).toEqual([2, 1]);
  });

  test('medoid picks the member nearest the centroid', () => {
    const cl = greedyCluster([
      { id: 'edge', vec: normalize([1, 0.5]) }, { id: 'mid', vec: normalize([1, 0.3]) }, { id: 'other', vec: normalize([1, 0.1]) },
    ], { threshold: 0.5 })[0];
    expect(medoid(cl).id).toBe('mid');
  });
});

describe('keyword fallback (TF-IDF)', () => {
  const docs = [
    { subject: 'Install Revit add-in', body: 'Need the Revit add-in manager installed' },
    { subject: 'Revit add-in missing', body: 'The add-in tab is gone in Revit' },
    { subject: 'VPN keeps dropping', body: 'GlobalProtect VPN disconnects every hour' },
    { subject: 'Cannot connect to VPN', body: 'GlobalProtect says gateway unreachable' },
    { subject: 'Roaming in the US', body: 'Travelling to Denver, need a roaming plan' },
  ];

  test('clusters paraphrases and keeps topics apart at KEYWORD_THRESHOLD', () => {
    const vecs = tfidfVectors(docs);
    const out = greedyCluster(docs.map((d, i) => ({ id: i, vec: vecs[i], at: 10 - i })), { mode: 'sparse' });
    const groups = out.map((c) => c.members.map((m) => m.id).sort());
    expect(groups).toEqual(expect.arrayContaining([[0, 1], [2, 3], [4]]));
    expect(KEYWORD_THRESHOLD).toBeLessThan(0.5);
  });

  test('sparseCosine basics', () => {
    expect(sparseCosine(new Map([['a', 1]]), new Map([['a', 2]]))).toBeCloseTo(1);
    expect(sparseCosine(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(0);
    expect(sparseCosine(new Map(), new Map([['b', 1]]))).toBe(0);
  });

  test('clusterKeywords names what sets the cluster apart', () => {
    const texts = docs.map((d) => `${d.subject}\n${d.body}`);
    expect(clusterKeywords(texts.slice(0, 2), texts, { limit: 2 })).toEqual(expect.arrayContaining(['revit']));
    expect(clusterKeywords(texts.slice(2, 4), texts, { limit: 3 })).toEqual(expect.arrayContaining(['vpn', 'globalprotect']));
  });
});

test('cleanSubject strips reply/forward prefixes and tags', () => {
  expect(cleanSubject('RE: FW: [External] Install  Revit')).toBe('Install Revit');
  expect(cleanSubject('Fwd: re: VPN')).toBe('VPN');
});

describe('audit fixes (Part B)', () => {
  test('gapTitle: scrubbed subject, names dropped, keywords when nothing is left', async () => {
    const { gapTitle } = await import('../src/services/knowledgeGapClustering.js');
    expect(gapTitle('NIck stone - EUROPE move')).toBe('EUROPE move');
    expect(gapTitle('NIck stone - EUROPE move', { people: [{ name: 'Nick Stone' }] })).toBe('EUROPE move');
    expect(gapTitle('RE: Europe move for Nick Stone', { people: [{ name: 'Nick Stone' }] })).toBe('Europe move');
    expect(gapTitle('Laptop for Priya Shah (604-555-0101)')).toBe('Laptop');
    expect(gapTitle('Nick Stone', { people: [{ name: 'Nick Stone' }], keywords: ['roaming', 'europe'] })).toBe('roaming · europe');
    expect(gapTitle('Install Revit add-in')).toBe('Install Revit add-in');
  });

  test('500 items cluster (with merges) well under a second: the merge pass is O(k²) per sweep', () => {
    // 60 topics in 64-d, each item = its topic axis + small noise; seeds
    // arrive in an order that creates drifted twins for the merge pass.
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const items = [];
    for (let i = 0; i < 500; i += 1) {
      const topic = i % 60;
      const v = Array.from({ length: 64 }, () => (rand() - 0.5) * 0.35);
      v[topic] += 1;
      items.push({ id: i, vec: v, at: 10000 - i });
    }
    const t0 = Date.now();
    const out = greedyCluster(items, { threshold: 0.6 });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(out.reduce((n, c) => n + c.members.length, 0)).toBe(500);
    expect(out.length).toBeLessThanOrEqual(80);
    // Every cluster is one topic.
    for (const c of out) expect(new Set(c.members.map((m) => m.id % 60)).size).toBe(1);
  });

  test('the worst case (every item its own cluster, k = MAX_CLUSTERS) stays bounded and fast', () => {
    const items = Array.from({ length: 500 }, (_, i) => {
      const v = new Array(256).fill(0);
      v[i % 256] = 1;
      v[(i * 7 + 3) % 256] += i >= 256 ? 0.01 : 0;
      return { id: i, vec: v, at: i };
    });
    const t0 = Date.now();
    const out = greedyCluster(items, { threshold: 0.99 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.reduce((n, c) => n + c.members.length, 0)).toBe(500);
  });

  test('the merge pass still joins a chain of drifted clusters', () => {
    const a = normalize([1, 0, 0]);
    const b = normalize([0.75, 0.66, 0]);
    const c = normalize([0.8, 0.6, 0]);
    const out = greedyCluster([{ id: 'a', vec: a, at: 3 }, { id: 'b', vec: b, at: 2 }, { id: 'c', vec: c, at: 1 }], { threshold: 0.75 });
    expect(out).toHaveLength(1);
  });
});
