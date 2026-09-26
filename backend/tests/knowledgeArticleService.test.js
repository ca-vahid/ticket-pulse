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
