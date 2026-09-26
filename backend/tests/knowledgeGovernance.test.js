import { jest } from '@jest/globals';

/**
 * Auto-help research requirements R1 (article governance) and R2 (section
 * chunks): owner + last-verified + review interval, overdue ranked down and
 * flagged, duplicate-title warning, "Needs review" list; heading-aware
 * sections that keep numbered lists whole, per-section embeddings with a
 * keyword-only fallback, and best-section retrieval.
 */
const prismaMock = {
  knowledgeArticle: { findMany: jest.fn(), create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
};
const embedMock = { configured: false, embedQueryTexts: jest.fn(async () => null) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => embedMock.configured,
  embedQueryTexts: (...a) => embedMock.embedQueryTexts(...a),
  cosineSimilarity: (a, b) => {
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  },
}));

const {
  default: service, isReviewOverdue, reviewDueAt, titleOverlap, STALE_FACTOR, DEFAULT_REVIEW_DAYS,
} = await import('../src/services/knowledgeArticleService.js');
const { splitArticleSections, splitBlocks } = await import('../src/utils/articleSections.js');

const DAY = 86400e3;
beforeEach(() => {
  jest.clearAllMocks();
  embedMock.configured = false;
  embedMock.embedQueryTexts = jest.fn(async () => null);
});

describe('R2 section splitting', () => {
  const para = (n, ch = 'x') => `<p>${ch.repeat(n)}</p>`;

  test('splits on h1-h4; a short section merges into the previous; the short intro merges forward', () => {
    const html = `<p>Short intro.</p><h2>Install</h2>${para(260)}<h3>Note</h3><p>tiny</p><h2>Uninstall</h2>${para(240, 'y')}<h5>Not a split</h5>${para(10, 'z')}`;
    const out = splitArticleSections(html);
    expect(out.map((s) => s.heading)).toEqual(['Install', 'Uninstall']);
    expect(out[0].text).toMatch(/^Short intro\./);
    expect(out[0].text).toContain('Note');
    expect(out[0].text).toContain('tiny');
    expect(out[1].text).toContain('Not a split');
  });

  test('a numbered list is never cut, even when the section is over the cap', () => {
    const list = `<ol>${Array.from({ length: 20 }, (_, i) => `<li>Step ${i + 1} ${'w'.repeat(180)}</li>`).join('')}</ol>`;
    const html = `<h2>Big</h2>${Array.from({ length: 10 }, () => para(300)).join('')}${list}`;
    const out = splitArticleSections(html);
    expect(out.length).toBeGreaterThan(1);
    const withList = out.filter((s) => s.text.includes('Step 1 ') || s.text.includes('Step 20 '));
    expect(withList).toHaveLength(1);
    expect(withList[0].text).toContain('Step 1 ');
    expect(withList[0].text).toContain('Step 20 ');
    expect(out[1].heading).toBe('Big (cont.)');
    expect(out.slice(0, -1).every((s) => s.text.length <= 2500)).toBe(true);
  });

  test('splitBlocks keeps nested lists and tables whole', () => {
    const blocks = splitBlocks('<p>a</p><ol><li>x<ul><li>y</li></ul></li><li>z</li></ol><table><tr><td><p>c</p></td></tr></table><p>d</p>');
    expect(blocks).toEqual(['<p>a</p>', '<ol><li>x<ul><li>y</li></ul></li><li>z</li></ol>', '<table><tr><td><p>c</p></td></tr></table>', '<p>d</p>']);
  });
});

describe('R2 indexing + best-section search', () => {
  const body = `<h2>Printers</h2><p>${'Add a printer from Settings, Devices, then pick the floor printer. '.repeat(4)}</p><h2>Install Bluebeam</h2><ol><li>Open Company Portal.</li><li>Search Bluebeam Revu.</li><li>Choose Install and wait for it to finish; keep the laptop on the network.</li></ol><p>${'More detail about the install. '.repeat(5)}</p>`;

  test('publishing stores sections with per-section embeddings', async () => {
    embedMock.configured = true;
    embedMock.embedQueryTexts = jest.fn(async (texts) => texts.map((_, i) => [1, i, 0]));
    prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 3, embedding: [], ...data }));
    prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => ({ id: 3, title: 'Apps', bodyText: 'x', status: 'published', ...data }));
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
    const out = await service.create(1, { title: 'Apps', bodyHtml: body, status: 'published' }, { email: 'Owner@Example.com' });
    const data = prismaMock.knowledgeArticle.update.mock.calls[0][0].data;
    expect(data.sections.map((s) => s.heading)).toEqual(['Printers', 'Install Bluebeam']);
    expect(data.sections[1].embedding).toEqual([1, 2, 0]);
    expect(data.embedding).toEqual([1, 0, 0]);
    expect(out.sectionHeadings).toEqual(['Printers', 'Install Bluebeam']);
    expect(out.sections).toBeUndefined();
  });

  test('an embedding failure keeps keyword-only sections', async () => {
    embedMock.configured = true;
    embedMock.embedQueryTexts = jest.fn(async () => { throw new Error('openai down'); });
    prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => ({ id: 3, ...data }));
    await service.indexArticle({ id: 3, title: 'Apps', bodyHtml: body, bodyText: 'x' });
    const data = prismaMock.knowledgeArticle.update.mock.calls[0][0].data;
    expect(data.sections).toHaveLength(2);
    expect(data.sections.every((s) => Array.isArray(s.embedding) && s.embedding.length === 0)).toBe(true);
    expect(data.embedding).toBeUndefined();
  });

  test('search scores an article by its best section and returns that section; overdue articles rank x0.7 and are flagged', async () => {
    const sections = splitArticleSections(body).map((s) => ({ ...s, embedding: [] }));
    const fresh = { id: 1, title: 'Apps', bodyText: 'x', tags: [], createdAt: new Date(), lastVerifiedAt: new Date(), reviewEveryDays: 180 };
    const old = { ...fresh, id: 2, lastVerifiedAt: new Date(Date.now() - 400 * DAY), createdAt: new Date(Date.now() - 400 * DAY) };
    prismaMock.knowledgeArticle.findMany.mockImplementation(async ({ select }) => {
      if (select?.sections) return [{ id: 1, sections }, { id: 2, sections }];
      return [fresh, old];
    });
    const hits = await service.search(1, 'install bluebeam company portal');
    expect(hits.map((h) => h.id)).toEqual([1, 2]);
    expect(hits[0].section.heading).toBe('Install Bluebeam');
    expect(hits[0].section.text).toContain('Open Company Portal.');
    expect(hits[0].section.text).not.toContain('floor printer');
    expect(hits[0].stale).toBe(false);
    expect(hits[1].stale).toBe(true);
    expect(hits[1].score).toBeCloseTo(Math.round(hits[0].score * STALE_FACTOR * 1000) / 1000, 2);
  });
});

describe('R1 governance', () => {
  test('owner defaults to the creator; publishing stamps lastVerifiedAt; review interval defaults to 180', async () => {
    prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 1, embedding: [], ...data }));
    prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
    await service.create(1, { title: 'Draft one', bodyHtml: '<p>x</p>', status: 'draft' }, { email: 'Kim@Example.com' });
    const d1 = prismaMock.knowledgeArticle.create.mock.calls[0][0].data;
    expect(d1).toMatchObject({ ownerEmail: 'kim@example.com', reviewEveryDays: DEFAULT_REVIEW_DAYS });
    expect(d1.lastVerifiedAt).toBeUndefined();
    await service.create(1, { title: 'Published', bodyHtml: '<p>x</p>', status: 'published', ownerEmail: 'lee@example.com', reviewEveryDays: 90 }, { email: 'kim@example.com' });
    const d2 = prismaMock.knowledgeArticle.create.mock.calls[1][0].data;
    expect(d2).toMatchObject({ ownerEmail: 'lee@example.com', reviewEveryDays: 90 });
    expect(d2.lastVerifiedAt).toBeInstanceOf(Date);
  });

  test('draft → published sets lastVerifiedAt; "Mark as verified" sets it too', async () => {
    const existing = { id: 5, workspaceId: 1, title: 'T', bodyText: 'b', bodyHtml: '<p>b</p>', status: 'draft', contentHash: 'x', embedding: [] };
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue(existing);
    prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => ({ ...existing, ...data }));
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
    await service.update(1, 5, { status: 'published' }, { email: 'a@x.com' });
    expect(prismaMock.knowledgeArticle.update.mock.calls[0][0].data.lastVerifiedAt).toBeInstanceOf(Date);
    prismaMock.knowledgeArticle.update.mockClear();
    await service.verify(1, 5, { email: 'a@x.com' });
    expect(prismaMock.knowledgeArticle.update.mock.calls[0][0].data.lastVerifiedAt).toBeInstanceOf(Date);
  });

  test('overdue maths and the view flags', () => {
    const now = Date.now();
    const row = { status: 'published', lastVerifiedAt: new Date(now - 100 * DAY), reviewEveryDays: 90 };
    expect(isReviewOverdue(row, now)).toBe(true);
    expect(isReviewOverdue({ ...row, reviewEveryDays: 180 }, now)).toBe(false);
    expect(isReviewOverdue({ ...row, status: 'draft' }, now)).toBe(false);
    expect(reviewDueAt({ createdAt: new Date(now) }).getTime()).toBe(now + 180 * DAY);
  });

  test('"Needs review" lists only overdue published articles', async () => {
    const now = Date.now();
    prismaMock.knowledgeArticle.findMany
      .mockResolvedValueOnce([
        { id: 1, status: 'published', lastVerifiedAt: new Date(now - 200 * DAY), reviewEveryDays: 180 },
        { id: 2, status: 'published', lastVerifiedAt: new Date(now - 10 * DAY), reviewEveryDays: 180 },
      ])
      .mockResolvedValueOnce([]);
    prismaMock.knowledgeArticle.count.mockResolvedValue(0);
    await service.list(1, { review: 'due' });
    expect(prismaMock.knowledgeArticle.findMany.mock.calls[1][0].where.id).toEqual({ in: [1] });
  });

  test('duplicate titles: normalized token overlap >= 0.8 warns (non-blocking)', async () => {
    expect(titleOverlap('Install software from Company Portal', 'Install software via the Company Portal')).toBeGreaterThanOrEqual(0.8);
    expect(titleOverlap('Install software from Company Portal', 'Reset your password')).toBe(0);
    prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 9, embedding: [], ...data }));
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([{ id: 4, title: 'Install software via the Company Portal' }, { id: 5, title: 'VPN setup' }]);
    const out = await service.create(1, { title: 'Install software from Company Portal', bodyHtml: '<p>x</p>', status: 'draft' }, { email: 'a@x.com' });
    expect(out.id).toBe(9);
    expect(out.warnings.similarTitles).toEqual([{ id: 4, title: 'Install software via the Company Portal', overlap: expect.any(Number) }]);
  });
});
