import { jest } from '@jest/globals';

/**
 * Confluence -> Knowledge (QA 10-23 #4). The one-time import lands articles
 * in the library as published + "Not checked yet" (a repeat becomes a draft
 * and a merge suggestion) and is resumable; the nightly sync only raises
 * suggestions (edit / new_article / retire) and says when Ticket Pulse
 * changed the article; nothing runs without a connection AND the switch;
 * every run leaves an audit row; the token never leaves the server.
 */
let settingsRow = null;
const prismaMock = {
  knowledgeSettings: {
    findUnique: jest.fn(async () => settingsRow),
    findFirst: jest.fn(async () => null),
    findMany: jest.fn(async () => []),
    upsert: jest.fn(async ({ create, update }) => {
      settingsRow = settingsRow ? { ...settingsRow, ...update } : { ...create };
      return { workspaceId: 1 };
    }),
  },
  knowledgeSourceRun: {
    create: jest.fn(async ({ data }) => ({ id: 77, ...data })),
    update: jest.fn(async ({ data }) => data),
    findMany: jest.fn(async () => []),
  },
  knowledgeArticle: { findMany: jest.fn(async () => []), update: jest.fn(async ({ data }) => data), findFirst: jest.fn(async () => null) },
  knowledgeSuggestion: { count: jest.fn(async () => 3), updateMany: jest.fn(async () => ({ count: 0 })) },
  competencyCategory: {
    findMany: jest.fn(async () => [
      { id: 10, name: 'Network', parentId: null, description: 'VPN, Wi-Fi' },
      { id: 11, name: 'VPN', parentId: 10, description: null },
      { id: 20, name: 'Printing', parentId: null, description: null },
    ]),
  },
};
const settingsMock = { record: jest.fn(async (ws, data) => { settingsRow = { ...(settingsRow || {}), ...data }; return { workspaceId: ws }; }) };
const suggestionMock = { create: jest.fn() };
const rightsMock = { skilledPeople: jest.fn(async () => []) };
const gatewayMock = { sendJson: jest.fn() };
const articleMock = { create: jest.fn(), get: jest.fn(), search: jest.fn(async () => []), similarTitles: jest.fn(async () => []) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: gatewayMock }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));
const realArticles = await import('../src/services/knowledgeArticleService.js');
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({ ...realArticles, default: articleMock }));
jest.unstable_mockModule('../src/services/knowledgeSuggestionService.js', () => ({ default: suggestionMock }));
jest.unstable_mockModule('../src/services/knowledgeSettingsService.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/knowledgeRights.js', () => ({ default: rightsMock }));
jest.unstable_mockModule('../src/services/tokenUsageService.js', () => ({ costUsdFor: () => 0.12 }));

const {
  default: service, buildTree, isSelected, cleanSelection, whatChanged, pageHash, deterministicLabel, IMPORT_ACTOR, siteAllowed,
} = await import('../src/services/confluenceKnowledgeService.js');
const { articleContentHash, htmlToText, sanitizeArticleHtml } = realArticles;

const SITE = 'https://example.atlassian.net';
const page = (id, parentId, over = {}) => ({
  id: String(id), title: `Page ${id}`, parentId: parentId ? String(parentId) : null, spaceId: '9', version: 1,
  updatedAt: '2026-10-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', webui: `/spaces/IT/pages/${id}`, ...over,
});
const body = (id) => `<h2>Fix ${id}</h2><p>Open the app and press reset. This is how the fix for ${id} works every time.</p>`;

function fakeClient({ pages, bodies = {}, restricted = [], missing = [] }) {
  return {
    siteUrl: SITE,
    listSpaces: jest.fn(async () => ({ spaces: [{ id: '9', key: 'IT', name: 'IT' }], complete: true })),
    listSpacePages: jest.fn(async (_id, opts = {}) => ({ complete: true, pages: pages.map((p) => ({ ...p, ...(opts.withBody ? { storage: bodies[p.id] || body(p.id) } : {}) })) })),
    getPage: jest.fn(async (id) => {
      if (missing.includes(String(id))) { const e = new Error('gone'); e.status = 404; throw e; }
      const p = pages.find((x) => x.id === String(id)) || page(id, null);
      return { ...p, storage: bodies[id] || body(id) };
    }),
    hasViewRestriction: jest.fn(async (id) => restricted.includes(String(id))),
    testConnection: jest.fn(async () => ({ ok: true })),
  };
}

const AUTH = { siteUrl: SITE, email: 'svc@example.com', apiToken: 'secret-token-123' };
const filed = (over = {}) => ({ parsed: { categoryId: 10, subcategoryId: 11, title: 'Reset the VPN', tags: ['vpn'], existingArticleId: 0, why: 'A VPN fix.', ...over }, usage: { inputTokens: 100, outputTokens: 20 }, provider: 'anthropic', model: 'claude-opus-4-8' });

let client;
beforeEach(() => {
  jest.clearAllMocks();
  settingsRow = {
    workspaceId: 1, confluenceEnabled: false, confluenceAuth: { ...AUTH }, confluenceSelection: { spaces: [{ id: '9', key: 'IT', name: 'IT' }], include: ['2'], exclude: ['4'] },
    confluenceState: {}, confluenceSyncedAt: null,
  };
  service.lockFn = async (_ws, fn) => ({ locked: true, result: await fn() });
  service.gateway = gatewayMock;
  // 1 = home, 2 = Solutions (ticked), 3 under 2, 4 under 2 (unticked), 5 = Meeting notes (not ticked)
  client = fakeClient({ pages: [page(1, null), page(2, 1), page(3, 2), page(4, 2), page(5, 1)] });
  service.clientFactory = async () => client;
  gatewayMock.sendJson.mockResolvedValue(filed());
  let nextId = 500;
  articleMock.create.mockImplementation(async (_ws, input) => ({ id: nextId++, ...input, contentHash: 'h' }));
  articleMock.get.mockImplementation(async (_ws, id) => ({ id, title: `Existing ${id}`, bodyHtml: '<p>Existing text</p>', categoryId: 20, subcategoryId: null }));
  suggestionMock.create.mockImplementation(async (_ws, input) => ({ suggestion: { id: 9, ...input }, created: true }));
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
});

describe('tree and selection (pure)', () => {
  test('counts per subtree; the homepage children are the sections', () => {
    const t = buildTree([
      { ...page(1, null), words: 10 }, { ...page(2, 1), words: 100, updatedAt: '2026-09-01T00:00:00Z' },
      { ...page(3, 2), words: 50, updatedAt: '2026-10-05T00:00:00Z' }, { ...page(5, 1), words: 5 },
    ]);
    expect(t.roots).toHaveLength(1);
    expect(t.sections.map((s) => s.id)).toEqual(['2', '5']);
    const two = t.byId.get('2');
    expect([two.pages, two.subtreeWords, two.lastUpdated]).toEqual([2, 150, '2026-10-05T00:00:00Z']);
    expect(t.roots[0].pages).toBe(4);
  });

  test('a ticked section brings its descendants; an unticked child stays out; whole spaces', () => {
    const t = buildTree([page(1, null), page(2, 1), page(3, 2), page(4, 2), page(6, 4), page(5, 1)]);
    const sel = cleanSelection({ spaces: [{ id: '9' }], include: ['2'], exclude: ['4'] });
    const picked = [...t.byId.values()].filter((p) => isSelected(p, t.byId, sel)).map((p) => p.id).sort();
    expect(picked).toEqual(['2', '3']);
    const whole = cleanSelection({ spaces: [{ id: '9' }], wholeSpaces: ['9'], exclude: ['5'] });
    expect([...t.byId.values()].filter((p) => isSelected(p, t.byId, whole)).map((p) => p.id).sort()).toEqual(['1', '2', '3', '4', '6']);
  });

  test('selection rejects anything that is not an id', () => {
    expect(() => cleanSelection({ include: ['1; drop'] })).toThrow(/not a Confluence id/);
    expect(cleanSelection({ spaces: [{ id: '9' }], wholeSpaces: ['9', '10'] }).wholeSpaces).toEqual(['9']);
  });

  test('stale rule and what changed', () => {
    expect(deterministicLabel({ lastUpdated: '2020-01-01T00:00:00Z' }, Date.parse('2026-10-23T00:00:00Z'))).toMatchObject({ label: 'stale', suggestion: 'skip' });
    expect(deterministicLabel({ lastUpdated: '2026-01-01T00:00:00Z' }, Date.parse('2026-10-23T00:00:00Z'))).toBeNull();
    const d = whatChanged({ oldTitle: 'A', oldText: 'one\ntwo', newTitle: 'B', newText: 'one\nthree\nfour' });
    expect(d.summary).toBe('In Confluence the title changed to "B", 2 paragraphs added or reworded, 1 removed.');
    expect(d.added).toEqual(['three', 'four']);
  });
});

describe('analyze', () => {
  test('returns the tree with counts and the model labels; writes an analyze run', async () => {
    gatewayMock.sendJson.mockResolvedValueOnce({ parsed: { sections: [{ id: '2', label: 'technical_solutions', reason: 'How-tos.', suggestion: 'include' }, { id: '5', label: 'meeting_notes', reason: 'Minutes.', suggestion: 'skip' }, { id: '99', label: 'policy', reason: 'x', suggestion: 'include' }] }, usage: { inputTokens: 50, outputTokens: 10 }, model: 'claude-sonnet-5-5' });
    const out = await service.analyze(1, { spaceIds: ['9'], withModel: true, actor: { email: 'lead@example.com' } });
    expect(out.spaces[0]).toMatchObject({ id: '9', key: 'IT', pages: 5, sectionIds: ['2', '5'] });
    expect(out.spaces[0].tree[0].children.find((c) => c.id === '2')).toMatchObject({ pages: 3, label: { label: 'technical_solutions', suggestion: 'include' } });
    expect(out.labels['99']).toBeUndefined();
    expect(gatewayMock.sendJson.mock.calls[0][0].operation).toBe('knowledge_confluence');
    expect(prismaMock.knowledgeSourceRun.create.mock.calls[0][0].data).toMatchObject({ kind: 'analyze', triggeredBy: 'lead@example.com' });
    expect(prismaMock.knowledgeSourceRun.update.mock.calls[0][0].data).toMatchObject({ status: 'done', counts: expect.objectContaining({ pagesSeen: 5, labelled: 2 }), model: 'claude-sonnet-5-5' });
    expect(settingsRow.confluenceState.labels['5'].suggestion).toBe('skip');
  });
});

describe('one-time import', () => {
  test('selected pages land published + not checked, filed at the higher-effort setting; restricted skipped', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1), page(3, 2), page(4, 2), page(5, 1)], restricted: ['3'] });
    const out = await service.runImport(1, { by: 'lead@example.com' });
    expect(out.counts).toMatchObject({ selected: 2, created: 1, restricted: 1, failed: 0 });
    expect(articleMock.create).toHaveBeenCalledTimes(1);
    const [ws, input, actor, opts] = articleMock.create.mock.calls[0];
    expect(ws).toBe(1);
    expect(input).toMatchObject({ status: 'published', source: 'confluence', externalId: '2', categoryId: 10, subcategoryId: 11, title: 'Reset the VPN', tags: ['vpn'] });
    expect(actor).toBe(IMPORT_ACTOR);
    expect(opts.canCheck).toBe(false);
    expect(opts.sourceMeta).toMatchObject({ url: `${SITE}/wiki/spaces/IT/pages/2`, spaceKey: 'IT', pageVersion: 1 });
    const call = gatewayMock.sendJson.mock.calls[0][0];
    expect(call.operation).toBe('knowledge_confluence_import');
    expect(call.extra.reasoning).toEqual({ effort: 'high' });
    expect(settingsRow.confluenceState.importedAt).toBeTruthy();
    expect(settingsRow.confluenceState.import.status).toBe('done');
    expect(prismaMock.knowledgeSourceRun.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'done', model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 20, costUsd: 0.12 });
  });

  test('pages filed where nobody has Intermediate are counted', async () => {
    rightsMock.skilledPeople.mockResolvedValue([]);
    const out = await service.runImport(1);
    expect(out.counts.noSkilledOwner).toBe(2);
    rightsMock.skilledPeople.mockResolvedValue([{ email: 'tech@example.com' }]);
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
    const again = await service.runImport(1);
    expect(again.counts.noSkilledOwner).toBe(0);
  });

  test('a repeat of an existing article becomes a draft + a merge suggestion, not a second article', async () => {
    articleMock.search.mockResolvedValue([{ id: 31, title: 'VPN reset', snippet: 'reset it' }]);
    gatewayMock.sendJson.mockResolvedValue(filed({ existingArticleId: 31 }));
    const out = await service.runImport(1);
    expect(out.counts).toMatchObject({ created: 0, mergeSuggested: 2 });
    expect(articleMock.create.mock.calls.every((c) => c[1].status === 'draft')).toBe(true);
    const merge = suggestionMock.create.mock.calls[0][1];
    expect(merge).toMatchObject({ kind: 'merge', source: 'confluence', articleId: 31, otherArticleId: 500, dedupeKey: 'confluence:2:1:repeat' });
    expect(merge.proposed.bodyHtml).toContain('<p>Existing text</p><h2>From Confluence:');
  });

  test('a model id that is not a candidate is ignored', async () => {
    gatewayMock.sendJson.mockResolvedValue(filed({ existingArticleId: 999, categoryId: 999, subcategoryId: 11 }));
    await service.runImport(1);
    expect(articleMock.create.mock.calls[0][1]).toMatchObject({ status: 'published', categoryId: 10, subcategoryId: 11 });
  });

  test('resumable: pages already imported are skipped on the next run', async () => {
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([{ id: 600, externalId: '2', status: 'published', sourceMeta: {} }]);
    const out = await service.runImport(1);
    expect(out.counts).toMatchObject({ alreadyImported: 1, created: 1 });
    expect(articleMock.create.mock.calls.map((c) => c[1].externalId)).toEqual(['3']);
  });

  test('a model failure still imports (uncategorised) and is counted', async () => {
    gatewayMock.sendJson.mockRejectedValue(new Error('timeout'));
    const out = await service.runImport(1);
    expect(out.counts).toMatchObject({ created: 2, noModel: 2 });
    expect(articleMock.create.mock.calls[0][1]).toMatchObject({ categoryId: null, title: 'Page 2' });
  });

  test('a failed listing fails the run and records the error', async () => {
    client.listSpacePages.mockRejectedValue(new Error('Confluence answered 500.'));
    await expect(service.runImport(1)).rejects.toThrow('500');
    expect(prismaMock.knowledgeSourceRun.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'failed', error: 'Confluence answered 500.' });
    expect(settingsRow.confluenceState.import.status).toBe('failed');
  });

  test('startImport refuses without a connection or a selection', async () => {
    settingsRow.confluenceAuth = {};
    await expect(service.startImport(1)).rejects.toThrow(/Connect to Confluence/);
    settingsRow.confluenceAuth = { ...AUTH };
    settingsRow.confluenceSelection = { spaces: [{ id: '9' }] };
    await expect(service.startImport(1)).rejects.toThrow(/Pick the spaces/);
  });
});

describe('nightly sync', () => {
  const imported = (id, over = {}) => {
    const html = sanitizeArticleHtml(body(id));
    const hash = pageHash(`Page ${id}`, body(id));
    const articleHash = articleContentHash('Reset the VPN', htmlToText(html));
    return {
      id: 600 + id, externalId: String(id), title: 'Reset the VPN', bodyHtml: html, status: 'published', version: 1, contentHash: articleHash, updatedBy: IMPORT_ACTOR.name,
      categoryId: 10, subcategoryId: 11, sourceMeta: { pageVersion: 1, importHash: hash, articleHash, url: `${SITE}/wiki/spaces/IT/pages/${id}` }, ...over,
    };
  };
  beforeEach(() => {
    settingsRow.confluenceEnabled = true;
    settingsRow.confluenceState = { importedAt: '2026-10-10T00:00:00Z' };
  });

  test('switched off -> nothing; no connection -> a skipped run, no Confluence call', async () => {
    settingsRow.confluenceEnabled = false;
    expect(await service.runNightly(1)).toEqual({ skipped: 'disabled' });
    expect(prismaMock.knowledgeSourceRun.create).not.toHaveBeenCalled();
    settingsRow.confluenceEnabled = true;
    settingsRow.confluenceAuth = { siteUrl: SITE };
    expect(await service.runNightly(1)).toEqual({ skipped: 'no_connection' });
    expect(prismaMock.knowledgeSourceRun.update.mock.calls[0][0].data).toMatchObject({ status: 'skipped', counts: { reason: 'no_connection' } });
    expect(client.listSpacePages).not.toHaveBeenCalled();
  });

  test('not imported yet -> skipped', async () => {
    settingsRow.confluenceState = {};
    expect(await service.runNightly(1)).toEqual({ skipped: 'import_first' });
  });

  test('changed page -> edit suggestion with the new text and what changed; unchanged -> nothing', async () => {
    client = fakeClient({
      pages: [page(1, null), page(2, 1, { version: 3 }), page(3, 2)],
      bodies: { 2: '<h2>Fix 2</h2><p>Open the app and press reset twice now.</p>' },
    });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2), imported(3)]);
    const out = await service.runNightly(1, { now: new Date('2026-10-23T06:00:00Z') });
    expect(out.counts).toMatchObject({ changed: 1, unchanged: 1, editedInTp: 0 });
    expect(suggestionMock.create).toHaveBeenCalledTimes(1);
    const s = suggestionMock.create.mock.calls[0][1];
    expect(s).toMatchObject({ kind: 'edit', source: 'confluence', articleId: 602, dedupeKey: 'confluence:2:3' });
    expect(s.proposed.bodyHtml).toContain('press reset twice now');
    expect(s.proposed.confluence).toMatchObject({ pageId: '2', pageVersion: 3 });
    expect(s.why).toMatch(/paragraph/);
    expect(s.why).not.toMatch(/Ticket Pulse wins/);
    expect(articleMock.create).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeSuggestion.updateMany.mock.calls[0][0].where.dedupeKey).toEqual({ startsWith: 'confluence:2:' });
    expect(settingsRow.confluenceSyncedAt).toEqual(new Date('2026-10-23T06:00:00Z'));
    expect(prismaMock.knowledgeSourceRun.create.mock.calls[0][0].data.kind).toBe('nightly');
  });

  test('edited in Ticket Pulse since the import -> the suggestion says Ticket Pulse wins, nothing overwritten', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1, { version: 2 })], bodies: { 2: '<p>A different procedure written in Confluence now.</p>' } });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2, { contentHash: 'changed-here', version: 2, updatedBy: 'tech@example.com' })]);
    const out = await service.runNightly(1);
    expect(out.counts.editedInTp).toBe(1);
    const s = suggestionMock.create.mock.calls[0][1];
    expect(s.why).toMatch(/changed in Ticket Pulse after the import, and Ticket Pulse wins/);
    expect(s.evidence.editedInTp).toBe(true);
    expect(s.proposed.title).toBeUndefined();
    expect(prismaMock.knowledgeArticle.update).not.toHaveBeenCalled();
  });

  test('only the version moved (same text) -> the version is recorded, no suggestion', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1, { version: 5 })] });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2)]);
    await service.runNightly(1);
    expect(suggestionMock.create).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeArticle.update.mock.calls[0][0].data.sourceMeta.pageVersion).toBe(5);
  });

  test('new page since the last run -> new_article filed into the library (pending); old never-imported page -> nothing', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1), page(3, 2, { createdAt: '2026-10-20T00:00:00Z' }), page(4, 3, { createdAt: '2026-09-01T00:00:00Z' })] });
    settingsRow.confluenceSelection = { spaces: [{ id: '9' }], include: ['2'] };
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2)]);
    gatewayMock.sendJson.mockResolvedValue(filed({ title: 'Map a printer' }));
    const out = await service.runNightly(1);
    expect(out.counts.newPages).toBe(1);
    const s = suggestionMock.create.mock.calls[0][1];
    expect(s).toMatchObject({ kind: 'new_article', categoryId: 10, subcategoryId: 11, dedupeKey: 'confluence:3:1' });
    expect(s.proposed).toMatchObject({ title: 'Map a printer', source: 'confluence', externalId: '3' });
    expect(gatewayMock.sendJson.mock.calls[0][0].operation).toBe('knowledge_confluence');
    expect(articleMock.create).not.toHaveBeenCalled();
  });

  test('a new page that belongs in an existing article -> add_section', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1), page(3, 2, { createdAt: '2026-10-20T00:00:00Z' })] });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2)]);
    articleMock.search.mockResolvedValue([{ id: 31, title: 'VPN reset', snippet: '' }]);
    gatewayMock.sendJson.mockResolvedValue(filed({ existingArticleId: 31 }));
    await service.runNightly(1);
    const s = suggestionMock.create.mock.calls[0][1];
    expect(s).toMatchObject({ kind: 'add_section', articleId: 31, categoryId: 20 });
    expect(s.proposed.sectionHtml).toMatch(/^<h2>Page 3<\/h2>/);
  });

  test('deleted page -> retire; moved out of the picked trees -> retire with its reason', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1), page(5, 1)], missing: ['7'] });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2), imported(7), imported(5)]);
    const out = await service.runNightly(1);
    expect(out.counts.retired).toBe(2);
    const kinds = suggestionMock.create.mock.calls.map((c) => [c[1].kind, c[1].articleId, c[1].evidence.reason, c[1].dedupeKey]);
    expect(kinds).toEqual([['retire', 607, 'deleted', 'confluence:7:1:gone'], ['retire', 605, 'moved', 'confluence:5:1:gone']]);
  });

  test('a partial listing never retires anything', async () => {
    client = fakeClient({ pages: [page(1, null), page(2, 1)] });
    client.listSpacePages.mockResolvedValue({ complete: false, pages: [page(1, null), page(2, 1)] });
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([imported(2), imported(7)]);
    const out = await service.runNightly(1);
    expect(out.counts.retireSkipped).toBe('partial_listing');
    expect(suggestionMock.create).not.toHaveBeenCalled();
  });

  test('a failure is recorded as a failed run and never throws', async () => {
    client.listSpacePages.mockRejectedValue(new Error('Confluence did not accept the e-mail and API token.'));
    const out = await service.runNightly(1);
    expect(out.status).toBe('failed');
    expect(prismaMock.knowledgeSourceRun.update.mock.calls.at(-1)[0].data).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not accept/) });
    expect(settingsRow.confluenceSyncedAt).toBeNull();
  });

  test('runAll only visits workspaces with the switch on', async () => {
    prismaMock.knowledgeSettings.findMany.mockResolvedValue([{ workspaceId: 1 }]);
    const out = await service.runAll();
    expect(prismaMock.knowledgeSettings.findMany.mock.calls[0][0].where).toEqual({ confluenceEnabled: true });
    expect(out[0]).toMatchObject({ workspaceId: 1, status: 'done' });
  });
});

describe('connection and settings', () => {
  test('the token is never in the view; members do not see the e-mail', async () => {
    const asManager = await service.view(1, { canManage: true });
    const asMember = await service.view(1, { canManage: false });
    expect(JSON.stringify(asManager)).not.toContain('secret-token-123');
    expect(JSON.stringify(asMember)).not.toContain('secret-token-123');
    expect(asManager).toMatchObject({ configured: true, tokenSet: true, email: 'svc@example.com', siteUrl: SITE, waiting: 3 });
    expect(asMember.email).toBeNull();
  });

  test('saving without a token keeps the saved one (same site); a new site needs a token', async () => {
    const out = await service.saveConnection(1, { siteUrl: 'example.atlassian.net', email: 'SVC@example.com', apiToken: '' }, { email: 'lead@example.com' });
    expect(settingsRow.confluenceAuth).toMatchObject({ siteUrl: SITE, email: 'svc@example.com', apiToken: 'secret-token-123' });
    expect(JSON.stringify(out)).not.toContain('secret-token-123');
    await expect(service.saveConnection(1, { siteUrl: 'https://other.atlassian.net', email: 'svc@example.com' })).rejects.toThrow(/API token/);
    // The token is sent to that address: only Confluence Cloud (or a host named on purpose).
    await expect(service.saveConnection(1, { siteUrl: 'https://intranet.example.com', email: 'svc@example.com', apiToken: 't' })).rejects.toThrow(/atlassian\.net/);
    expect(siteAllowed('https://wiki.example.com', { KNOWLEDGE_CONFLUENCE_HOSTS: 'wiki.example.com' })).toBe(true);
  });

  test('the nightly switch needs a finished import; clearing the connection switches it off', async () => {
    await expect(service.setNightly(1, true)).rejects.toThrow(/one-time import first/);
    settingsRow.confluenceState = { importedAt: '2026-10-10T00:00:00Z' };
    expect((await service.setNightly(1, true)).enabled).toBe(true);
    const cleared = await service.clearConnection(1);
    expect(cleared).toMatchObject({ enabled: false, configured: false, tokenSet: false });
  });

  test('test connection reports a failure in words instead of throwing', async () => {
    client.testConnection.mockRejectedValue(new Error('Confluence did not accept the e-mail and API token.'));
    expect(await service.testConnection(1)).toEqual({ ok: false, message: 'Confluence did not accept the e-mail and API token.' });
  });
});
