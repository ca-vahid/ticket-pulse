import { jest } from '@jest/globals';

/**
 * FreshService solution import, against a MOCKED FreshService client (no
 * HTTP ever): Link-header paging (a short page is not the end), published
 * only, idempotency by updated_at and content hash, archive rules (never on a
 * partial listing), folder ids checked against the workspace's FreshService,
 * one bad article skipped, the per-workspace lock, create-or-update on the
 * unique index, the complete ordered scan of existing articles, lanes, and
 * "Import now" as a background job with progress. Outside production run()
 * stops at a dry-run plan before any client exists.
 */
const prismaMock = {
  knowledgeArticle: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
};
let stored = {};
const settingsMock = {
  get: jest.fn(async (ws) => ({ workspaceId: ws, fsImportEnabled: true, fsFolderIds: ['7'], ...stored })),
  record: jest.fn(async (_ws, data) => { stored = { ...stored, ...data, updatedAt: new Date() }; return stored; }),
  enabledWorkspaces: jest.fn(),
};
const indexMock = jest.fn(async (row) => row);
const fsConfigMock = jest.fn(() => { throw new Error('must not be called'); });
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/knowledgeSettingsService.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { getFreshServiceConfigForWorkspace: fsConfigMock } }));
const createClientMock = jest.fn(() => { throw new Error('the real FreshService client must never be created in tests'); });
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: createClientMock }));
const { htmlToText } = await import('../src/utils/articleSections.js');
const crypto = await import('node:crypto');
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({
  default: { indexArticle: indexMock },
  htmlToText,
  sanitizeArticleHtml: (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').trim(),
  articleContentHash: (title, text) => crypto.createHash('sha256').update(`${title}|${text}`).digest('hex'),
}));

const {
  default: service, FsSolutionImportService, fsCallsAllowed, fsArticleUrl, linkNext, PER_PAGE, MAX_PAGES, IMPORT_STALE_MS,
} = await import('../src/services/fsSolutionImportService.js');

const art = (id, extra = {}) => ({
  id, title: `Article ${id}`, description: `<p>Body of ${id}</p>`, status: 2, folder_id: 7, category_id: 3,
  updated_at: '2026-09-01T00:00:00Z', tags: ['vpn'], ...extra,
});
const NEXT = { link: '<https://acme.freshservice.com/api/v2/solutions/articles?page=2>; rel="next"' };

/**
 * A fake client. `folders[id]` is either an array (paged by PER_PAGE, no Link
 * header) or an explicit list of pages [{ items, headers }]. The folder list
 * (categories -> folders) holds every folder in `folders` + `known`.
 */
function fakeClient(folders, { fail = [], known = [] } = {}) {
  const calls = [];
  const folderIds = [...new Set([...Object.keys(folders), ...fail, ...known].map(String))];
  return {
    domain: 'acme.freshservice.com',
    calls,
    _fetchWithRetry: jest.fn(async (endpoint, { params = {} } = {}) => {
      calls.push({ endpoint, params });
      if (endpoint === '/solutions/articles') {
        if (fail.includes(String(params.folder_id))) throw new Error('FreshService 500');
        const src = folders[String(params.folder_id)] || [];
        if (src.length && src[0]?.items) {
          const page = src[params.page - 1] || { items: [] };
          return { data: { articles: page.items }, headers: page.headers || {} };
        }
        const start = (params.page - 1) * params.per_page;
        return { data: { articles: src.slice(start, start + params.per_page) }, headers: {} };
      }
      const detail = endpoint.match(/^\/solutions\/articles\/(\d+)$/);
      if (detail) return { data: { article: { description: `<p>Full body ${detail[1]}</p>` } }, headers: {} };
      if (endpoint === '/solutions/categories') return { data: { categories: params.page === 1 ? [{ id: 3, name: 'IT how-tos' }] : [] }, headers: {} };
      if (endpoint === '/solutions/folders') {
        return { data: { folders: params.page === 1 ? folderIds.map((id) => ({ id: Number(id), name: `Folder ${id}` })) : [] }, headers: {} };
      }
      throw new Error(`unexpected ${endpoint}`);
    }),
  };
}
const articleCalls = (client) => client.calls.filter((c) => c.endpoint === '/solutions/articles');
const archivedUpdates = () => prismaMock.knowledgeArticle.update.mock.calls.map((c) => c[0]).filter((u) => u.data.status === 'archived');
const lockAlways = async (ws, fn) => ({ locked: true, result: await fn() });

let svc;
beforeEach(() => {
  jest.clearAllMocks();
  stored = {};
  svc = new FsSolutionImportService();
  svc.lockFn = lockAlways;
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  prismaMock.knowledgeArticle.findFirst.mockResolvedValue(null);
  prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => ({ id: 1000 + Number(data.externalId), ...data }));
  prismaMock.knowledgeArticle.update.mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
});

test('outside production: run() returns the dry-run plan and never builds a client', async () => {
  expect(fsCallsAllowed({ NODE_ENV: 'development' })).toBe(false);
  expect(fsCallsAllowed({ NODE_ENV: 'production' })).toBe(true);
  expect(fsCallsAllowed({ NODE_ENV: 'development', KNOWLEDGE_FS_IMPORT_ALLOW_NONPROD: 'true' })).toBe(true);
  const out = await service.run(1);
  expect(out).toMatchObject({ dryRun: true, reason: 'not_production' });
  expect(out.wouldCall[0]).toMatch(/folder_id=7&per_page=100/);
  expect(createClientMock).not.toHaveBeenCalled();
  await expect(service.listFolders(1)).rejects.toThrow(/only fetched in production/);
  expect(await service.startImport(1)).toMatchObject({ dryRun: true });
});

test('an explicit dry run stops before any call even with a client available', async () => {
  const client = fakeClient({ 7: [art(1)] });
  svc.clientFactory = () => client;
  const out = await svc.run(1, { dryRun: true });
  expect(out.dryRun).toBe(true);
  expect(client._fetchWithRetry).not.toHaveBeenCalled();
});

describe('paging', () => {
  test('linkNext reads the Link header', () => {
    expect(linkNext(NEXT)).toBe('next');
    expect(linkNext({ Link: '<https://x/api/v2/a?page=1>; rel="prev"' })).toBe('last');
    expect(linkNext({})).toBeNull();
    expect(linkNext(undefined)).toBeNull();
  });

  test('without Link headers, a short page is not the end: it walks on until an empty page', async () => {
    const client = fakeClient({
      7: [
        { items: [...Array(PER_PAGE)].map((_, i) => art(i + 1)) },
        { items: [art(201), art(202)] }, // short page 2
        { items: [art(301)] }, // ...but page 3 still has an article
        { items: [] },
      ],
    });
    svc.clientFactory = () => client;
    const out = await svc.run(1);
    expect(articleCalls(client).map((c) => c.params.page)).toEqual([1, 2, 3, 4]);
    expect(out.created).toBe(PER_PAGE + 3);
    expect(out.archiveSkipped).toBeNull();
  });

  test('with Link headers, rel="next" is followed even after a short page, and a page without "next" ends it', async () => {
    const client = fakeClient({
      7: [
        { items: [art(1), art(2)], headers: NEXT }, // short, but FreshService says there is more
        { items: [art(3)], headers: { link: '<https://acme.freshservice.com/api/v2/solutions/articles?page=1>; rel="prev"' } },
        { items: [art(99)] }, // never read
      ],
    });
    svc.clientFactory = () => client;
    const out = await svc.run(1);
    expect(articleCalls(client).map((c) => c.params.page)).toEqual([1, 2]);
    expect(out.created).toBe(3);
  });

  test('pages through a folder (per_page 100) and imports only published articles', async () => {
    const many = [...Array(PER_PAGE + 5)].map((_, i) => art(i + 1, i % 50 === 0 ? { status: 1 } : {}));
    const client = fakeClient({ 7: many });
    svc.clientFactory = () => client;
    const out = await svc.run(1);
    expect(articleCalls(client).map((c) => c.params)).toEqual([
      { folder_id: '7', page: 1, per_page: 100 },
      { folder_id: '7', page: 2, per_page: 100 },
      { folder_id: '7', page: 3, per_page: 100 },
    ]);
    expect(out.skippedUnpublished).toBe(3); // ids 1, 51, 101 are drafts (status 1)
    expect(out.created).toBe(102);
    const data = prismaMock.knowledgeArticle.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: 1, source: 'fs_solution', externalId: '2', status: 'published', tags: ['freshservice', 'vpn'],
      sourceMeta: { folderId: '7', categoryId: '3', url: 'https://acme.freshservice.com/a/solutions/articles/2' },
    });
    expect(data.fsUpdatedAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(indexMock).toHaveBeenCalledTimes(102);
    expect(stored.fsImportState).toMatchObject({ status: 'done', created: 102 });
  });

  test('a listing cut off at MAX_PAGES is partial: nothing is archived from FreshService', async () => {
    const client = fakeClient({ 7: [...Array(MAX_PAGES + 1)].map((_, p) => ({ items: [art(p + 1)], headers: NEXT })) });
    svc.clientFactory = () => client;
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { id: 6, externalId: '5000', status: 'published', sourceMeta: { folderId: '7' } }, // beyond the cut-off, may well exist
    ]);
    const out = await svc.run(1);
    expect(articleCalls(client)).toHaveLength(MAX_PAGES);
    expect(out.archiveSkipped).toBe('partial_listing');
    expect(archivedUpdates()).toEqual([]);
  });
});

test('idempotent: unchanged updated_at is skipped without reading or re-indexing', async () => {
  const client = fakeClient({ 7: [art(1)] });
  svc.clientFactory = () => client;
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([
    { id: 5, externalId: '1', title: 'Article 1', status: 'published', contentHash: 'x', fsUpdatedAt: new Date('2026-09-01T00:00:00Z'), sourceMeta: { folderId: '7' } },
  ]);
  const out = await svc.run(1);
  expect(out).toMatchObject({ created: 0, updated: 0, unchanged: 1, archived: 0 });
  expect(prismaMock.knowledgeArticle.update).not.toHaveBeenCalled();
  expect(indexMock).not.toHaveBeenCalled();
});

test('a newer updated_at with the same text only moves the date; changed text re-indexes', async () => {
  const { articleContentHash } = await import('../src/services/knowledgeArticleService.js');
  const sameHash = articleContentHash('Article 1', 'Body of 1');
  const client = fakeClient({ 7: [art(1, { updated_at: '2026-09-20T00:00:00Z' }), art(2, { updated_at: '2026-09-20T00:00:00Z', description: '<p>New text</p>' })] });
  svc.clientFactory = () => client;
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([
    { id: 5, externalId: '1', title: 'Article 1', status: 'published', contentHash: sameHash, fsUpdatedAt: new Date('2026-09-01T00:00:00Z'), sourceMeta: { folderId: '7' } },
    { id: 6, externalId: '2', title: 'Article 2', status: 'published', contentHash: 'old', fsUpdatedAt: new Date('2026-09-01T00:00:00Z'), sourceMeta: { folderId: '7' } },
  ]);
  const out = await svc.run(1);
  expect(out).toMatchObject({ updated: 1, unchanged: 1 });
  const upd = prismaMock.knowledgeArticle.update.mock.calls.map((c) => c[0]);
  expect(upd.find((u) => u.where.id === 5).data).not.toHaveProperty('bodyHtml');
  expect(upd.find((u) => u.where.id === 6).data).toMatchObject({ bodyText: 'New text', status: 'published', embedding: [], sections: [] });
  expect(indexMock).toHaveBeenCalledTimes(1);
});

describe('archiving', () => {
  test('complete listing: deleted / unpublished in FreshService and unticked folders are archived', async () => {
    const client = fakeClient({ 7: [art(1), art(3, { status: 1 })] });
    svc.clientFactory = () => client;
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { id: 5, externalId: '1', status: 'published', fsUpdatedAt: new Date('2026-09-01T00:00:00Z'), sourceMeta: { folderId: '7' } },
      { id: 6, externalId: '2', status: 'published', sourceMeta: { folderId: '7' } }, // gone from FS
      { id: 7, externalId: '3', status: 'published', sourceMeta: { folderId: '7' } }, // now a draft in FS
      { id: 9, externalId: '5', status: 'published', sourceMeta: { folderId: '11' } }, // folder no longer picked
    ]);
    const out = await svc.run(1);
    expect(archivedUpdates().map((u) => [u.where.id, u.data.sourceMeta.archivedReason])).toEqual([
      [6, 'deleted_in_fs'], [7, 'unpublished_in_fs'], [9, 'folder_removed'],
    ]);
    expect(out.archived).toBe(3);
  });

  test('one folder failing makes the listing partial: only unticked folders are archived', async () => {
    settingsMock.get.mockResolvedValue({ fsImportEnabled: true, fsFolderIds: ['7', '9'] });
    const client = fakeClient({ 7: [art(1)] }, { fail: ['9'] });
    svc.clientFactory = () => client;
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { id: 6, externalId: '2', status: 'published', sourceMeta: { folderId: '7' } }, // missing from 7, but the run is partial
      { id: 8, externalId: '4', status: 'published', sourceMeta: { folderId: '9' } }, // folder 9 failed to list
      { id: 9, externalId: '5', status: 'published', sourceMeta: { folderId: '11' } }, // folder no longer picked
    ]);
    const out = await svc.run(1);
    expect(archivedUpdates().map((u) => [u.where.id, u.data.sourceMeta.archivedReason])).toEqual([[9, 'folder_removed']]);
    expect(out.failedFolders).toEqual([{ folderId: '9', error: 'FreshService 500' }]);
    expect(out.archiveSkipped).toBe('partial_listing');
    settingsMock.get.mockImplementation(async (ws) => ({ workspaceId: ws, fsImportEnabled: true, fsFolderIds: ['7'], ...stored }));
  });
});

describe('folder ids belong to this workspace\'s FreshService', () => {
  test('a picked folder that is not in the folder list is never read; its old articles are archived after a complete run', async () => {
    settingsMock.get.mockResolvedValue({ fsImportEnabled: true, fsFolderIds: ['7', '4242'] });
    const client = fakeClient({ 7: [art(1)] }); // 4242 is not in this FreshService
    svc.clientFactory = () => client;
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { id: 8, externalId: '77', status: 'published', sourceMeta: { folderId: '4242' } },
    ]);
    const out = await svc.run(1);
    expect(articleCalls(client).map((c) => c.params.folder_id)).toEqual(['7', '7']);
    expect(out.unknownFolders).toEqual(['4242']);
    expect(archivedUpdates().map((u) => u.data.sourceMeta.archivedReason)).toEqual(['folder_missing_in_fs']);
    settingsMock.get.mockImplementation(async (ws) => ({ workspaceId: ws, fsImportEnabled: true, fsFolderIds: ['7'], ...stored }));
  });

  test('validateFolderIds refuses ids that are not there (interactive lane)', async () => {
    const factory = jest.fn(() => fakeClient({ 7: [] }, { known: ['8'] }));
    svc.clientFactory = factory;
    await expect(svc.validateFolderIds(1, ['7', '8'])).resolves.toMatchObject({ checked: true });
    await expect(svc.validateFolderIds(1, ['7', '31337'])).rejects.toThrow(/31337 is not in this workspace's FreshService/);
    expect(factory.mock.calls.every(([, opts]) => opts.interactive === true)).toBe(true);
    expect(await service.validateFolderIds(1, ['7'])).toEqual({ checked: false }); // local: never calls FreshService
  });
});

test('one failing article is logged and skipped; the rest import', async () => {
  const client = fakeClient({ 7: [art(1), art(2), art(3)] });
  svc.clientFactory = () => client;
  indexMock.mockImplementation(async (row) => { if (row.externalId === '2') throw new Error('embedding 500'); return row; });
  const out = await svc.run(1);
  expect(out.created).toBe(2);
  expect(out.failedArticles).toEqual([{ id: '2', error: 'embedding 500' }]);
  expect(out.status).toBe('done');
  expect(archivedUpdates()).toEqual([]);
  indexMock.mockImplementation(async (row) => row);
});

test('create hitting the unique index (a row the scan did not see) becomes an update', async () => {
  const client = fakeClient({ 7: [art(1)] });
  svc.clientFactory = () => client;
  prismaMock.knowledgeArticle.create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
  prismaMock.knowledgeArticle.findFirst.mockResolvedValueOnce({ id: 44, sourceMeta: {} });
  const out = await svc.run(1);
  expect(out).toMatchObject({ created: 0, updated: 1 });
  const upd = prismaMock.knowledgeArticle.update.mock.calls[0][0];
  expect(upd.where).toEqual({ id: 44 });
  expect(upd.data).not.toHaveProperty('externalId');
  expect(prismaMock.knowledgeArticle.findFirst.mock.calls[0][0].where).toEqual({ workspaceId: 1, source: 'fs_solution', externalId: '1' });
});

test('the existing-article scan is ordered and complete (paged by id), not one unordered take', async () => {
  const pageOne = [...Array(1000)].map((_, i) => ({ id: i + 1, externalId: String(10000 + i), status: 'archived', sourceMeta: { folderId: '7' } }));
  const pageTwo = [{ id: 5001, externalId: '1', title: 'Article 1', status: 'published', contentHash: 'x', fsUpdatedAt: new Date('2026-09-01T00:00:00Z'), sourceMeta: { folderId: '7' } }];
  prismaMock.knowledgeArticle.findMany.mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo);
  const client = fakeClient({ 7: [art(1)] });
  svc.clientFactory = () => client;
  const out = await svc.run(1);
  const calls = prismaMock.knowledgeArticle.findMany.mock.calls.map((c) => c[0]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ orderBy: { id: 'asc' }, take: 1000, where: { workspaceId: 1, source: 'fs_solution', id: { gt: 0 } } });
  expect(calls[1].where.id).toEqual({ gt: 1000 });
  expect(out).toMatchObject({ created: 0, unchanged: 1 }); // found on page 2, not duplicated
});

test('the workspace lock: a run that cannot take it skips without calling FreshService', async () => {
  const client = fakeClient({ 7: [art(1)] });
  svc.clientFactory = jest.fn(() => client);
  svc.lockFn = async () => ({ locked: false });
  expect(await svc.run(1)).toEqual({ skipped: 'running' });
  expect(svc.clientFactory).not.toHaveBeenCalled();
});

test('switched off or no folders -> nothing happens; runs never overlap in one process', async () => {
  settingsMock.get.mockResolvedValueOnce({ fsImportEnabled: false, fsFolderIds: ['7'] });
  expect(await svc.run(1)).toEqual({ skipped: 'disabled' });
  settingsMock.get.mockResolvedValueOnce({ fsImportEnabled: true, fsFolderIds: [] });
  expect(await svc.run(1)).toEqual({ skipped: 'no_folders' });
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeClient({ 7: [art(1)] });
  client._fetchWithRetry.mockImplementationOnce(async () => { await gate; return { data: { categories: [] }, headers: {} }; });
  svc.clientFactory = () => client;
  const first = svc.run(1);
  await new Promise((r) => setTimeout(r, 0));
  expect(await svc.run(1)).toEqual({ skipped: 'running' });
  release();
  await first;
});

describe('lanes', () => {
  test('folder picker and "Import now" use the interactive client; the nightly import the low-priority one', async () => {
    fsConfigMock.mockImplementation(async () => ({ domain: 'acme', apiKey: 'k', workspaceId: 2 }));
    createClientMock.mockImplementation(() => fakeClient({ 7: [art(1)] }));
    await svc._client(1, { interactive: true });
    await svc._client(1, { interactive: false });
    expect(createClientMock.mock.calls[0][2]).toMatchObject({ priority: 'high', queueTimeoutMs: 15000 });
    expect(createClientMock.mock.calls[1][2]).toMatchObject({ priority: 'low', source: 'kb-solution-import' });
    fsConfigMock.mockImplementation(() => { throw new Error('must not be called'); });
    createClientMock.mockImplementation(() => { throw new Error('the real FreshService client must never be created in tests'); });

    const factory = jest.fn(() => fakeClient({ 7: [art(1)] }));
    svc.clientFactory = factory;
    await svc.listFolders(1, { refresh: true });
    expect(factory.mock.calls[0][1]).toEqual({ interactive: true });
    settingsMock.enabledWorkspaces.mockResolvedValue([{ workspaceId: 1 }]);
    factory.mockClear();
    await svc.runAll();
    expect(factory.mock.calls[0][1]).toEqual({ interactive: false });
    factory.mockClear();
    await svc.run(1, { force: true, interactive: true });
    expect(factory.mock.calls[0][1]).toEqual({ interactive: true });
  });
});

describe('"Import now" runs in the background with progress', () => {
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => { setImmediate(r); }); };

  test('returns a job id at once; the status endpoint shows running, then done', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const client = fakeClient({ 7: [art(1), art(2)] });
    const inner = client._fetchWithRetry.getMockImplementation();
    client._fetchWithRetry.mockImplementation(async (endpoint, cfg) => {
      if (endpoint === '/solutions/articles' && cfg.params.page === 1) await gate;
      return inner(endpoint, cfg);
    });
    svc.clientFactory = () => client;
    const job = await svc.startImport(1, { actor: { email: 'vahid@example.com' } });
    expect(job).toEqual({ jobId: expect.stringMatching(/^fsi-1-/), status: 'queued' });
    await settle();
    expect(await svc.jobStatus(1, job.jobId)).toMatchObject({ jobId: job.jobId, status: 'running', by: 'vahid@example.com', progress: { foldersTotal: 1 } });
    await expect(svc.startImport(1)).rejects.toThrow(/already running/);
    release();
    await settle();
    expect(await svc.jobStatus(1, job.jobId)).toMatchObject({ status: 'done', created: 2, progress: { foldersDone: 1, articlesSeen: 2 } });
    expect(await svc.jobStatus(1, 'fsi-other')).toMatchObject({ jobId: 'fsi-other', status: 'unknown' });
  });

  test('a job whose heartbeat stopped (restart) reads as interrupted and may be started again', async () => {
    stored = { fsImportState: { jobId: 'fsi-1-old', status: 'running', heartbeatAt: new Date(Date.now() - IMPORT_STALE_MS - 1000).toISOString() } };
    expect(await svc.jobStatus(1, 'fsi-1-old')).toMatchObject({ status: 'interrupted' });
    svc.clientFactory = () => fakeClient({ 7: [art(1)] });
    await expect(svc.startImport(1)).resolves.toMatchObject({ status: 'queued' });
    await settle();
  });
});

test('listFolders: categories then folders per category, cached, with completeness', async () => {
  const client = fakeClient({ 7: [] }, { known: ['8'] });
  svc.clientFactory = () => client;
  const out = await svc.listFolders(1);
  expect(out.complete).toBe(true);
  expect(out.categories).toEqual([{ id: '3', name: 'IT how-tos', folders: [{ id: '7', name: 'Folder 7', description: null }, { id: '8', name: 'Folder 8', description: null }] }]);
  expect(client.calls.find((c) => c.endpoint === '/solutions/folders').params).toMatchObject({ category_id: 3, per_page: 100 });
  const n = client._fetchWithRetry.mock.calls.length;
  await svc.listFolders(1);
  expect(client._fetchWithRetry).toHaveBeenCalledTimes(n);
});

test('fsArticleUrl', () => {
  expect(fsArticleUrl('acme', 12)).toBe('https://acme.freshservice.com/a/solutions/articles/12');
  expect(fsArticleUrl(null, 12)).toBeNull();
});
