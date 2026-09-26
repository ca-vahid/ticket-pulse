import { jest } from '@jest/globals';

/**
 * Auto-help tools (25 Sep 2026 audit): no resolution / private notes leak,
 * the similar-ticket search cannot be steered by the model or by ticket
 * references in the text, other requesters are redacted, and articles are
 * workspace- and published-scoped.
 */
const ARTICLES = [
  { id: 12, workspaceId: 1, status: 'published', title: 'Company Portal installs', bodyText: 'Open Company Portal.', tags: [] },
  { id: 13, workspaceId: 2, status: 'published', title: 'Other workspace secret', bodyText: 'Not yours.', tags: [] },
  { id: 14, workspaceId: 1, status: 'draft', title: 'Draft', bodyText: 'Unpublished.', tags: [] },
];
const prismaMock = {
  knowledgeArticle: {
    findFirst: jest.fn(async ({ where, select }) => {
      const row = ARTICLES.find((a) => a.id === where.id && a.workspaceId === where.workspaceId && a.status === where.status);
      return row ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : null;
    }),
    findMany: jest.fn(async () => []),
  },
  ticket: { findMany: jest.fn() },
};
const similarityMock = { search: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketSimilaritySearchService.js', () => ({ default: similarityMock }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { resolveBaseStatus: jest.fn(async (_ws, s) => (['Resolved', 'Closed'].includes(s) ? s : 'Open')) },
}));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
}));

const { executeAutoHelpTool, SUBMIT_AUTO_HELP_TOOL, AUTO_HELP_TOOLS } = await import('../src/services/autoHelpTools.js');

const ctxFor = (over = {}) => ({
  workspaceId: 1,
  ticket: {
    id: 55, subject: 'Install Bluebeam', descriptionText: 'Same as TP-77 and #241406 please. Could you install Bluebeam?',
    internalCategoryId: 10, internalSubcategoryId: 101, internalCategory: { name: 'Software' }, requester: { name: 'Pat', email: 'pat@x.com' },
  },
  playbook: { id: 3, allowedTools: ['search_knowledge', 'get_article', 'find_similar_resolved_tickets', 'get_ticket_details'], kbScope: { mode: 'all' } },
  sources: new Map(),
  evidence: new Map(),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('get_article', () => {
  test('reads a published article of the same workspace', async () => {
    const ctx = ctxFor();
    const out = await executeAutoHelpTool('get_article', { id: 12 }, ctx);
    expect(out).toMatchObject({ sourceId: 'article:12', title: 'Company Portal installs' });
    expect(ctx.sources.has('article:12')).toBe(true);
    expect(ctx.evidence.get('article:12')).toContain('Open Company Portal.');
  });

  test('another workspace\'s article returns nothing and is never remembered', async () => {
    const ctx = ctxFor();
    const out = await executeAutoHelpTool('get_article', { id: 13 }, ctx);
    expect(out.error).toMatch(/not found/i);
    expect(ctx.sources.size).toBe(0);
    expect(prismaMock.knowledgeArticle.findFirst.mock.calls[0][0].where).toMatchObject({ id: 13, workspaceId: 1, status: 'published' });
  });

  test('an article with sections returns the best-matching sections for this ticket, not the whole body (R2)', async () => {
    prismaMock.knowledgeArticle.findFirst.mockResolvedValueOnce({
      id: 12, title: 'Company Portal', bodyText: 'whole body', tags: [],
      sections: [
        { heading: 'Printers', text: 'Add the floor printer from Settings.' },
        { heading: 'Install Bluebeam', text: 'Open Company Portal, search Bluebeam, choose Install.' },
        { heading: 'Licences', text: 'Ask your manager for a licence.' },
      ],
    });
    const ctx = ctxFor();
    const out = await executeAutoHelpTool('get_article', { id: 12 }, ctx);
    expect(out.sections.map((x) => x.heading)).toContain('Install Bluebeam');
    expect(out.sections).toHaveLength(2);
    expect(out.text).toBeUndefined();
    expect(out.otherSections).toHaveLength(1);
    expect(ctx.sources.get('article:12')).toMatchObject({ section: expect.any(String) });
  });

  test('drafts are not readable', async () => {
    expect((await executeAutoHelpTool('get_article', { id: 14 }, ctxFor())).error).toBeDefined();
  });
});

describe('find_similar_resolved_tickets', () => {
  test('never returns resolution notes; only verified solutions of resolved tickets; refs stripped; model query ignored; people redacted', async () => {
    similarityMock.search.mockResolvedValue({ results: { q: [{ id: 101, score: 0.8 }, { id: 102, score: 0.7 }, { id: 103, score: 0.9 }, { id: 55, score: 1 }] } });
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 101, workspaceId: 1, subject: 'Bluebeam for Jane Roe', status: 'Resolved', solutionNote: 'Installed from Company Portal; Jane Roe (jane@corp.com) confirmed.', solutionVerifiedAt: new Date(), requester: { name: 'Jane Roe', email: 'jane@corp.com' } },
      { id: 102, workspaceId: 1, subject: 'Still open', status: 'Open', solutionNote: 'Verified but open', solutionVerifiedAt: new Date(), requester: null },
      { id: 103, workspaceId: 2, subject: 'Other workspace', status: 'Closed', solutionNote: 'nope', solutionVerifiedAt: new Date(), requester: null },
    ]);
    const ctx = ctxFor();
    const out = await executeAutoHelpTool('find_similar_resolved_tickets', { query: 'TP-9999 payroll salaries' }, ctx);

    const [ws, items, opts] = similarityMock.search.mock.calls[0];
    expect(ws).toBe(1);
    expect(items[0].text).not.toMatch(/TP-77|#241406|payroll/);
    expect(items[0].text).toMatch(/Bluebeam/);
    expect(opts.status).toEqual(['resolved', 'closed']);

    const findArgs = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({ workspaceId: 1, solutionVerifiedAt: { not: null } });
    expect(findArgs.select.resolutionNote).toBeUndefined();
    expect(findArgs.where.id.in).not.toContain(55);

    expect(out.results.map((r) => r.sourceId)).toEqual(['ticket:101']);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/resolutionNote|Jane|jane@corp\.com/);
    expect(out.results[0].verifiedSolution).toContain('Company Portal');
    expect([...ctx.sources.keys()]).toEqual(['ticket:101']);
  });

  test('its schema takes no query', () => {
    const schema = AUTO_HELP_TOOLS.find((t) => t.name === 'find_similar_resolved_tickets').schema.input_schema;
    expect(schema.properties).toEqual({});
  });
});

describe('get_ticket_details', () => {
  test('returns only the current ticket\'s public fields', async () => {
    const out = await executeAutoHelpTool('get_ticket_details', {}, ctxFor());
    expect(Object.keys(out).sort()).toEqual(['category', 'createdAt', 'description', 'priority', 'requesterName', 'subcategory', 'subject']);
  });
});

test('submit schema has no text field and a 200-char subject', () => {
  expect(SUBMIT_AUTO_HELP_TOOL.input_schema.properties.text).toBeUndefined();
  expect(SUBMIT_AUTO_HELP_TOOL.input_schema.properties.subject.maxLength).toBe(200);
});

test('disallowed tools are refused', async () => {
  const out = await executeAutoHelpTool('get_requester_profile', {}, ctxFor());
  expect(out.error).toMatch(/not available/);
});
