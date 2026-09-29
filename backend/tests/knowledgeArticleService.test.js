import { jest } from '@jest/globals';

/** Knowledge articles: body sanitizing, publish rules, keyword-only search fallback. */
const prismaMock = {
  knowledgeArticle: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
}));

const { default: service, htmlToText, keywordScore, queryTokens, hybridScore, normalizeCosine } = await import('../src/services/knowledgeArticleService.js');

beforeEach(() => jest.clearAllMocks());

test('create sanitizes the body and derives plain text', async () => {
  prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 1, embedding: [], ...data }));
  const out = await service.create(1, { title: ' Install  apps ', bodyHtml: '<p>Open <b>Company Portal</b></p><script>alert(1)</script>', status: 'draft' }, { email: 'a@x' });
  expect(out.title).toBe('Install apps');
  expect(out.bodyHtml).not.toMatch(/script/);
  expect(out.bodyText).toBe('Open Company Portal');
  expect(out.embedded).toBe(false);
  expect(out.embedding).toBeUndefined();
});

test('headings survive sanitizing (h1 -> h2, h5/h6 -> h4) so sections can split on them', async () => {
  prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 2, embedding: [], ...data }));
  const out = await service.create(1, {
    title: 'VPN', bodyHtml: '<h1>Before</h1><p>a</p><h2>Connect</h2><p>b</p><h3>Sub</h3><h4>Deep</h4><h5>Deeper</h5><h6>Deepest</h6>', status: 'draft',
  }, { email: 'a@x' });
  expect(out.bodyHtml).toBe('<h2>Before</h2><p>a</p><h2>Connect</h2><p>b</p><h3>Sub</h3><h4>Deep</h4><h4>Deeper</h4><h4>Deepest</h4>');
});

test('a published article needs a body', async () => {
  await expect(service.create(1, { title: 'Empty', bodyHtml: '', status: 'published' })).rejects.toThrow(/needs a body/);
});

test('search falls back to keyword scoring without embeddings; title hits rank first', async () => {
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([
    { id: 1, title: 'Printer setup', bodyText: 'Add a printer', tags: [], embedding: [] },
    { id: 2, title: 'Install Bluebeam from Company Portal', bodyText: 'Open Company Portal and install Bluebeam', tags: ['install'], embedding: [] },
    { id: 3, title: 'VPN', bodyText: 'Mentions bluebeam once', tags: [], embedding: [] },
  ]);
  const hits = await service.search(1, 'Please install Bluebeam on my laptop');
  expect(hits[0]).toMatchObject({ id: 2, matchedOn: 'keyword' });
  expect(hits.map((h) => h.id)).not.toContain(1);
});

test('helpers', () => {
  expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
  expect(queryTokens('How do I install the VPN?')).toEqual(['install', 'vpn']);
  expect(keywordScore(['vpn'], { title: 'VPN guide' })).toBe(1);
});

test('keyword scoring is whole-word: "app" does not hit "approval"', () => {
  expect(keywordScore(['app'], { title: 'Approval workflow', bodyText: 'approvals and apps' })).toBe(0);
  expect(keywordScore(['app'], { title: 'Install an app' })).toBe(1);
});

test('keyword and embedding scores share one 0..1 scale', () => {
  expect(normalizeCosine(0.15)).toBe(0);
  expect(normalizeCosine(0.65)).toBe(1);
  expect(hybridScore({ keyword: 0.5 })).toBe(0.5);
  expect(hybridScore({ cosine: 0.65, keyword: 1 })).toBeCloseTo(1);
  expect(hybridScore({ cosine: 0.1, keyword: 0 })).toBe(0);
});

test('search is bounded: published + workspace filtered in SQL, keyword prefilter, only needed columns', async () => {
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  await service.search(7, 'Install Bluebeam');
  const arg = prismaMock.knowledgeArticle.findMany.mock.calls[0][0];
  expect(arg.where).toMatchObject({ workspaceId: 7, status: 'published' });
  expect(arg.where.OR).toEqual(expect.arrayContaining([{ title: { contains: 'install', mode: 'insensitive' } }]));
  expect(arg.take).toBeLessThanOrEqual(300);
  expect(arg.select.embedding).toBeUndefined();
  expect(arg.select.bodyHtml).toBeUndefined();
});

test('delete archives instead of removing the row', async () => {
  prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ id: 5, status: 'published' });
  prismaMock.knowledgeArticle.update.mockResolvedValue({});
  const out = await service.remove(1, 5, { email: 'a@x' });
  expect(out).toEqual({ id: 5, archived: true, status: 'archived' });
  expect(prismaMock.knowledgeArticle.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { status: 'archived', updatedBy: 'a@x' } });
  expect(prismaMock.knowledgeArticle.delete).toBeUndefined();
});

test('the default list hides archived; status=archived shows them', async () => {
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  prismaMock.knowledgeArticle.count.mockResolvedValue(0);
  await service.list(1, {});
  expect(prismaMock.knowledgeArticle.findMany.mock.calls[0][0].where.status).toEqual({ not: 'archived' });
  await service.list(1, { status: 'archived' });
  expect(prismaMock.knowledgeArticle.findMany.mock.calls[1][0].where.status).toBe('archived');
});

describe('Knowledge v2: Topics, provenance, Quoted by (28 Sep 2026)', () => {
  test('articleView: the legacy drafted tag leaves Topics and becomes sourceLabel', async () => {
    const { articleView, sourceLabelOf } = await import('../src/services/knowledgeArticleService.js');
    const legacy = articleView({ id: 1, source: 'tp', tags: ['VPN', 'drafted-from-tickets'], bodyText: '' });
    expect(legacy.tags).toEqual(['VPN']);
    expect(legacy.sourceLabel).toBe('Drafted from tickets');
    expect(sourceLabelOf({ source: 'tp', sourceMeta: { draftedFrom: { kind: 'gap' } }, tags: [] })).toBe('Drafted from tickets');
    expect(sourceLabelOf({ source: 'fs_solution' })).toBe('FreshService solution');
    expect(sourceLabelOf({ source: 'verified_ticket' })).toBe('Verified solution');
    expect(sourceLabelOf({ source: 'tp', tags: [] })).toBe('Written in Ticket Pulse');
  });

  test('playbooksReaching: same category; listed subcategories must include the article\'s (or the article has none)', async () => {
    const { playbooksReaching } = await import('../src/services/knowledgeArticleService.js');
    const pbs = [
      { id: 1, name: 'Installs', enabled: true, categoryId: 10, subcategoryIds: [101] },
      { id: 2, name: 'All software', enabled: false, categoryId: 10, subcategoryIds: [] },
      { id: 3, name: 'Other sub', enabled: true, categoryId: 10, subcategoryIds: [102] },
      { id: 4, name: 'Network', enabled: true, categoryId: 20, subcategoryIds: [] },
    ];
    expect(playbooksReaching({ categoryId: 10, subcategoryId: 101 }, pbs)).toEqual([
      { playbookId: 1, name: 'Installs', enabled: true },
      { playbookId: 2, name: 'All software', enabled: false },
    ]);
    expect(playbooksReaching({ categoryId: 10, subcategoryId: null }, pbs).map((p) => p.playbookId)).toEqual([1, 2, 3]);
    expect(playbooksReaching({ categoryId: null }, pbs)).toEqual([]);
  });

  test('get and list carry quotedBy + timesQuoted (one playbook read, one grouped count)', async () => {
    prismaMock.autoHelpPlaybook = { findMany: jest.fn(async () => [{ id: 1, name: 'Installs', enabled: true, categoryId: 10, subcategoryIds: [] }]) };
    prismaMock.$queryRaw = jest.fn(async () => [{ sourceId: 'article:5', n: 4 }]);
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ id: 5, workspaceId: 1, source: 'tp', title: 'A', bodyText: 'x', tags: [], categoryId: 10, subcategoryId: null });
    const one = await service.get(1, 5);
    expect(one.quotedBy).toEqual([{ playbookId: 1, name: 'Installs', enabled: true }]);
    expect(one.timesQuoted).toBe(4);

    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { id: 5, title: 'A', bodyText: 'x', tags: [], categoryId: 10 },
      { id: 6, title: 'B', bodyText: 'y', tags: [], categoryId: 30 },
    ]);
    prismaMock.knowledgeArticle.count.mockResolvedValue(2);
    prismaMock.autoHelpPlaybook.findMany.mockClear();
    prismaMock.$queryRaw.mockClear();
    const { items } = await service.list(1, {});
    expect(prismaMock.autoHelpPlaybook.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(items.map((a) => [a.id, a.quotedBy.length, a.timesQuoted])).toEqual([[5, 1, 4], [6, 0, 0]]);
    // The raw query was given the cited source ids as one array parameter.
    expect(prismaMock.$queryRaw.mock.calls[0]).toEqual(expect.arrayContaining([['article:5', 'article:6']]));
    delete prismaMock.autoHelpPlaybook;
    delete prismaMock.$queryRaw;
  });

  test('reach degrades to [] / 0 when the reads fail', async () => {
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ id: 5, workspaceId: 1, source: 'tp', title: 'A', bodyText: 'x', tags: [], categoryId: 10 });
    const one = await service.get(1, 5);
    expect(one.quotedBy).toEqual([]);
    expect(one.timesQuoted).toBe(0);
  });

  test('topics: prefix (LIKE-escaped), top list mapped to { topic, count }; fails soft', async () => {
    prismaMock.$queryRaw = jest.fn(async () => [{ topic: 'VPN', count: 3 }, { topic: 'Vpn client', count: 1 }]);
    expect(await service.topics(1, { q: ' vP ' })).toEqual([{ topic: 'VPN', count: 3 }, { topic: 'Vpn client', count: 1 }]);
    const values = prismaMock.$queryRaw.mock.calls[0].slice(1);
    expect(values).toEqual(expect.arrayContaining([1, 'vp%', 'drafted-from-tickets', 15]));
    await service.topics(1, { q: '50%_off' });
    expect(prismaMock.$queryRaw.mock.calls[1].slice(1)).toContain('50\\%\\_off%');
    prismaMock.$queryRaw = jest.fn(async () => { throw new Error('no db'); });
    expect(await service.topics(1, {})).toEqual([]);
    delete prismaMock.$queryRaw;
  });
});
