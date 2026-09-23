import { jest } from '@jest/globals';

/**
 * ContinuIT search request (23 Sep 2026): hybrid similarity search for free
 * text. Pure scoring helpers + the service over mocked Prisma/embeddings.
 */
const prismaMock = {
  ticket: { findMany: jest.fn() },
  ticketEmbedding: { findMany: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
const embedMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    listStatuses: jest.fn().mockResolvedValue([
      { name: 'Open', baseStatus: 'Open', isActive: true },
      { name: 'Pending', baseStatus: 'Pending', isActive: true },
      { name: 'Pending Response', baseStatus: 'Pending', isActive: true },
      { name: 'Resolved', baseStatus: 'Resolved', isActive: true },
      { name: 'Closed', baseStatus: 'Closed', isActive: true },
    ]),
  },
}));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  EMBEDDING_MODEL: 'text-embedding-3-small',
  embedQueryTexts: embedMock,
  isEmbeddingConfigured: () => true,
}));

const mod = await import('../src/services/ticketSimilaritySearchService.js');
const {
  officesIn, identifierTokens, referencesIn, keywordQuery, semanticScore, blendScore, SCORE_MODEL, TicketSimilaritySearchService,
} = mod;

// 4-dim "embeddings" are enough for the geometry.
const V = {
  firewall: [1, 0.1, 0, 0],
  printer: [0, 1, 0.1, 0],
  laptop: [0, 0.1, 1, 0],
  vpn: [0.2, 0, 0.1, 1],
};
const TICKETS = {
  1: { id: 1, subject: 'Fredericton firewall replacement', descriptionText: 'Swap the FortiGate at Fredericton when the unit arrives.', status: 'Open', origin: 'ticketpulse', nativeNumber: 1591, freshserviceTicketId: null, externalRef: null, createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-20'), dueBy: null, customFields: {}, requester: { name: 'Om', email: 'om@bgc.ca', department: 'IT', entraDepartment: null, entraOfficeLocation: 'Fredericton' }, assignedTech: { name: 'Soheil', email: 's@bgc.ca' } },
  2: { id: 2, subject: 'Calgary printer jams', descriptionText: 'Toner and jams on floor 2.', status: 'Pending Response', origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 243301n, externalRef: null, createdAt: new Date('2026-09-02'), updatedAt: new Date('2026-09-19'), dueBy: null, customFields: {}, requester: { name: 'Ann', email: 'ann@bgc.ca', department: null, entraDepartment: 'Geo', entraOfficeLocation: 'Calgary' }, assignedTech: null },
  3: { id: 3, subject: 'Laptop order for new hire', descriptionText: 'Order a Lenovo for Perth.', status: 'Open', origin: 'ticketpulse', nativeNumber: 1600, freshserviceTicketId: null, externalRef: 'continuit:task:9', createdAt: new Date('2026-09-03'), updatedAt: new Date('2026-09-18'), dueBy: new Date('2026-10-01'), customFields: {}, requester: null, assignedTech: null },
  4: { id: 4, subject: 'VPN client BGC1 profile broken', descriptionText: 'Profile for BGC1 gateway fails.', status: 'Open', origin: 'ticketpulse', nativeNumber: 1601, freshserviceTicketId: null, externalRef: null, createdAt: new Date('2026-09-04'), updatedAt: new Date('2026-09-17'), dueBy: null, customFields: {}, requester: null, assignedTech: null },
  5: { id: 5, subject: 'Monitor arm request', descriptionText: 'No embedding yet.', status: 'Open', origin: 'ticketpulse', nativeNumber: 1602, freshserviceTicketId: null, externalRef: null, createdAt: new Date('2026-09-05'), updatedAt: new Date('2026-09-16'), dueBy: null, customFields: {}, requester: null, assignedTech: null },
};
const VEC_BY_TICKET = { 1: V.firewall, 2: V.printer, 3: V.laptop, 4: V.vpn };

function wire({ candidates = [1, 2, 3, 4, 5], keyword = [], refs = [] } = {}) {
  prismaMock.ticket.findMany.mockImplementation(async (args) => {
    if (args.select?.id && Object.keys(args.select).length === 1 && !args.where?.OR?.some?.((o) => o.nativeNumber || o.freshserviceTicketId)) {
      if (args.where?.id) return [];
      return candidates.map((id) => ({ id }));
    }
    if (args.where?.OR?.some?.((o) => o.nativeNumber || o.freshserviceTicketId)) return refs.map((id) => ({ id }));
    return (args.where.id.in || []).map((id) => TICKETS[id]).filter(Boolean);
  });
  prismaMock.ticketEmbedding.findMany.mockImplementation(async (args) => {
    const ids = args.where.ticketId?.in || [];
    return ids.filter((id) => VEC_BY_TICKET[id]).map((id) => ({ ticketId: id, embedding: VEC_BY_TICKET[id] }));
  });
  prismaMock.$queryRawUnsafe.mockResolvedValue(keyword.map(([id, r]) => ({ id, r })));
}

beforeEach(() => {
  jest.clearAllMocks();
  embedMock.mockImplementation(async (texts) => texts.map((t) => (/firewall/i.test(t) ? [0.95, 0.12, 0.02, 0] : /printer|toner/i.test(t) ? [0, 1, 0.1, 0] : [0.3, 0.3, 0.3, 0.3])));
});

describe('pure helpers', () => {
  test('officesIn finds office names as whole words, case-insensitively', () => {
    expect([...officesIn('the firewall for the CALGARY office')]).toEqual(['Calgary']);
    expect(officesIn('calgaryish').size).toBe(0);
  });

  test('identifierTokens keeps mixed letter+digit names and drops TP refs and plain words', () => {
    expect([...identifierTokens('Fix BGC1 and A82, not VPN or TP-1580; CGY-FS01 too')].sort()).toEqual(['a82', 'bgc1', 'cgy-fs01']);
  });

  test('referencesIn reads TP-refs and #FreshService ids', () => {
    expect(referencesIn('see TP-1580 and #241406, not #12')).toEqual({ native: [1580], freshservice: ['241406'] });
  });

  test('keywordQuery ORs the significant words and drops stop words', () => {
    expect(keywordQuery("We'll replace the failing firewall at Fredericton next week")).toBe('replace or failing or firewall or fredericton');
  });

  test('semanticScore rises with standing-out and falls on an office conflict', () => {
    const base = { cosine: 0.65, z: 3, gap: 0.08 };
    expect(semanticScore({ ...base, z: 4 })).toBeGreaterThan(semanticScore(base));
    expect(semanticScore({ ...base, gap: 0.15 })).toBeGreaterThan(semanticScore(base));
    expect(semanticScore({ ...base, officeConflict: true })).toBeLessThan(semanticScore(base));
    expect(semanticScore({ ...base, officeMatch: true })).toBeGreaterThan(semanticScore(base));
  });

  test('office agreement alone cannot carry a score over "likely" (2026-09-23b)', () => {
    // Below the line without the office: capped just under it.
    const weak = { cosine: 0.6, z: 3, gap: 0.05 };
    expect(semanticScore(weak)).toBeLessThan(SCORE_MODEL.thresholds.likely);
    expect(semanticScore({ ...weak, officeMatch: true })).toBeLessThan(SCORE_MODEL.thresholds.likely);
    expect(semanticScore({ ...weak, officeMatch: true })).toBeGreaterThanOrEqual(semanticScore(weak));
    // Already over the line without it: the office still adds.
    const strong = { cosine: 0.75, z: 4.5, gap: 0.15 };
    expect(semanticScore(strong)).toBeGreaterThan(SCORE_MODEL.thresholds.likely);
    expect(semanticScore({ ...strong, officeMatch: true })).toBeGreaterThan(semanticScore(strong));
    // A typical unrelated best match (raw 0.55, z 2, gap 0.01) stays under "possible".
    expect(semanticScore({ cosine: 0.55, z: 2, gap: 0.01 })).toBeLessThan(SCORE_MODEL.thresholds.possible);
  });

  test('blendScore: exact reference = 1; keyword-only capped at 0.6; an identifier lifts to 0.75; requester adds 0.05', () => {
    expect(blendScore({ exactRef: true })).toEqual({ score: 1, matchedOn: 'keyword' });
    expect(blendScore({ semantic: null, keyword: 0.9 })).toEqual({ score: 0.6, matchedOn: 'keyword' });
    expect(blendScore({ semantic: 0.3, identifierHit: true }).score).toBe(0.75);
    expect(blendScore({ semantic: 0.5 }).matchedOn).toBe('semantic');
    expect(blendScore({ semantic: 0.5, keyword: 0.2 }).matchedOn).toBe('both');
    expect(blendScore({ semantic: 0.5, requesterMatch: true }).score).toBe(0.55);
  });
});

describe('validation', () => {
  const svc = new TicketSimilaritySearchService();
  test('options: limits, score range, base statuses, dates', () => {
    expect(svc.normalizeOptions({})).toMatchObject({ limit: 5, minScore: 0.5, bases: ['open', 'pending'] });
    expect(() => svc.normalizeOptions({ limit: 21 })).toThrow(/limit/);
    expect(() => svc.normalizeOptions({ minScore: 1.5 })).toThrow(/minScore/);
    expect(() => svc.normalizeOptions({ status: ['open', 'waiting'] })).toThrow(/status/);
    expect(() => svc.normalizeOptions({ updatedFrom: 'soon' })).toThrow(/updatedFrom/);
    expect(svc.normalizeOptions({ status: 'Resolved' }).bases).toEqual(['resolved']);
  });

  test('items: at most 20, unique keys, a real text', () => {
    expect(() => svc.normalizeItems([])).toThrow(/at least one/);
    expect(() => svc.normalizeItems(Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, text: 'printer toner' })))).toThrow(/At most 20/);
    expect(() => svc.normalizeItems([{ key: 'a', text: 'printer' }, { key: 'a', text: 'firewall' }])).toThrow(/Duplicate/);
    expect(() => svc.normalizeItems([{ key: 'a', text: ' x ' }])).toThrow(/at least/);
  });
});

describe('search()', () => {
  test('the paraphrase finds its ticket first, with the published shape', async () => {
    wire();
    const svc = new TicketSimilaritySearchService();
    const { results, meta } = await svc.search(1, [{ key: 'q', text: 'the firewall for Fredericton' }], { minScore: 0 });
    const top = results.q[0];
    expect(top).toMatchObject({ id: 1, ref: 'TP-1591', subject: 'Fredericton firewall replacement', baseStatus: 'open', office: 'Fredericton', externalReferences: [] });
    expect(top.url).toMatch(/\/tickets\/1$/);
    expect(top.snippet).toMatch(/FortiGate/);
    expect(top.score).toBeGreaterThan(results.q[1].score);
    expect(meta).toMatchObject({ scoreModel: SCORE_MODEL.version, semantic: true, candidates: 5, embedded: 4 });
  });

  test('status names map through base statuses (Pending Response counts as pending) and the prefix exclusion keeps null refs', async () => {
    wire();
    const svc = new TicketSimilaritySearchService();
    await svc.search(1, [{ key: 'q', text: 'printer toner' }], { excludeExternalRefPrefix: 'continuit:' });
    const where = prismaMock.ticket.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(expect.arrayContaining(['Open', 'Pending', 'Pending Response']));
    expect(where.status.in).not.toContain('Resolved');
    expect(where.OR).toEqual([{ externalRef: null }, { NOT: { externalRef: { startsWith: 'continuit:' } } }]);
    expect(where.isNoise).toBe(false);
  });

  test('a ticket with no embedding is still found by the keyword half, as matchedOn "keyword", capped at 0.6', async () => {
    wire({ keyword: [[5, 0.4]] });
    const svc = new TicketSimilaritySearchService();
    const { results } = await svc.search(1, [{ key: 'q', text: 'monitor arm request' }], { minScore: 0 });
    const hit = results.q.find((h) => h.id === 5);
    expect(hit).toMatchObject({ matchedOn: 'keyword' });
    expect(hit.score).toBeLessThanOrEqual(0.6);
  });

  test('a FreshService number returns that ticket with score 1 and externalReferences filled', async () => {
    wire({ refs: [2] });
    const svc = new TicketSimilaritySearchService();
    const { results } = await svc.search(1, [{ key: 'q', text: 'any news on #243301?' }], { minScore: 0.5 });
    expect(results.q[0]).toMatchObject({ id: 2, ref: '#243301', score: 1, matchedOn: 'keyword', externalReferences: [{ system: 'FRESHSERVICE', id: '243301' }] });
  });

  test('an exact identifier (BGC1) lifts the ticket that names it', async () => {
    wire();
    const svc = new TicketSimilaritySearchService();
    const { results } = await svc.search(1, [{ key: 'q', text: 'the BGC1 thing again' }], { minScore: 0 });
    expect(results.q[0]).toMatchObject({ id: 4, matchedOn: 'both' });
    expect(results.q[0].score).toBeGreaterThanOrEqual(0.75);
  });

  test('minScore filters and limit caps; a batch embeds every text in ONE call and answers per key', async () => {
    wire();
    const svc = new TicketSimilaritySearchService();
    const { results } = await svc.search(1, [{ key: 'a', text: 'the firewall for Fredericton' }, { key: 'b', text: 'printer toner in Calgary' }], { limit: 1, minScore: 0 });
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(results)).toEqual(['a', 'b']);
    expect(results.a).toHaveLength(1);
    expect(results.b[0].id).toBe(2);
    const strict = await svc.search(1, [{ key: 'a', text: 'something vague' }], { minScore: 0.99 });
    expect(strict.results.a).toEqual([]);
  });

  test('query vectors and ticket vectors are cached: a repeat call embeds nothing and reads no vectors', async () => {
    wire();
    const svc = new TicketSimilaritySearchService();
    await svc.search(1, [{ key: 'q', text: 'printer toner cached' }], {});
    const reads = prismaMock.ticketEmbedding.findMany.mock.calls.length;
    await svc.search(1, [{ key: 'q', text: 'printer toner cached' }], {});
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketEmbedding.findMany.mock.calls.length).toBe(reads);
  });

  test('embedding outage → keyword only, meta.semantic false, no throw', async () => {
    wire({ keyword: [[1, 0.5]] });
    embedMock.mockRejectedValue(new Error('429'));
    const svc = new TicketSimilaritySearchService();
    const { results, meta } = await svc.search(1, [{ key: 'q', text: 'firewall outage text' }], { minScore: 0 });
    expect(meta.semantic).toBe(false);
    expect(results.q[0]).toMatchObject({ id: 1, matchedOn: 'keyword' });
  });
});
