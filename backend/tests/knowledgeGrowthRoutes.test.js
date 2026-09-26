import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Knowledge growth routes (Auto-help P1), mounted through knowledge.routes.js
 * so they share its role gate: members read gaps / backtest results / their
 * own review list; drafting, FreshService settings + folders and backtests
 * are manager-only; backtests need an explicit confirm; drafting is
 * rate-limited per person.
 */
const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn() },
};
const gapsMock = { gaps: jest.fn(async () => ({ playbooks: [] })), clearCache: jest.fn() };
const draftsMock = { draftFromTickets: jest.fn(async () => ({ article: { id: 5 }, used: 1, skipped: [] })), draftFromTicket: jest.fn() };
const settingsMock = { get: jest.fn(async () => ({ fsImportEnabled: false, fsFolderIds: [] })), update: jest.fn(async (ws, body) => body) };
const importMock = {
  listFolders: jest.fn(async () => ({ categories: [] })),
  startImport: jest.fn(async () => ({ dryRun: true })),
  jobStatus: jest.fn(async (ws, id) => ({ jobId: id || 'fsi-1-a', status: 'running', progress: { foldersDone: 1, foldersTotal: 2 } })),
  validateFolderIds: jest.fn(async () => ({ checked: true })),
};
const digestMock = { forOwner: jest.fn(async () => ({ count: 2, groups: [] })) };
const backtestMock = {
  estimate: jest.fn(async () => ({ count: 3, totalUsd: 0.1 })), start: jest.fn(async () => ({ status: 'running' })),
  status: jest.fn(() => null), cancel: jest.fn(() => null), results: jest.fn(async () => ({ counts: {}, runs: [] })),
};
const refMock = { resolveTicketRefOrThrow: jest.fn(async (ref) => ({ id: Number(String(ref).replace(/\D/g, '')) })) };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({ default: {}, disclosureLine: () => null }));
jest.unstable_mockModule('../src/services/knowledgeGapService.js', () => ({ default: gapsMock }));
jest.unstable_mockModule('../src/services/articleDraftService.js', () => ({ default: draftsMock, DRAFT_MAX_TICKETS: 12 }));
jest.unstable_mockModule('../src/services/knowledgeSettingsService.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/fsSolutionImportService.js', () => ({ default: importMock, fsCallsAllowed: () => false }));
jest.unstable_mockModule('../src/services/knowledgeReviewDigestService.js', () => ({ default: digestMock }));
jest.unstable_mockModule('../src/services/autoHelpBacktestService.js', () => ({ default: backtestMock, MAX_N: 50 }));
jest.unstable_mockModule('../src/services/ticketRefResolver.js', () => refMock);
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
}));

const { default: router } = await import('../src/routes/knowledge.routes.js');
const { _resetDraftRateLimit, DRAFT_RATE_LIMIT } = await import('../src/routes/knowledgeGrowth.routes.js');

const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const MEMBER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };

function app(user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { user }; req.workspaceId = 1; next(); });
  a.use('/api/knowledge', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetDraftRateLimit();
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
});

test('members read gaps (days passed through), backtest results and their own review list', async () => {
  const g = await request(app(MEMBER)).get('/api/knowledge/gaps?days=30');
  expect(g.status).toBe(200);
  expect(gapsMock.gaps).toHaveBeenCalledWith(1, { days: '30', refresh: false });
  expect((await request(app(MEMBER)).get('/api/knowledge/playbooks/3/backtest-results')).status).toBe(200);
  const d = await request(app(MEMBER)).get('/api/knowledge/review-digest');
  expect(d.body.data.count).toBe(2);
  expect(digestMock.forOwner).toHaveBeenCalledWith(1, 'viewer@example.com');
  expect((await request(app(MEMBER)).get('/api/knowledge/growth-settings')).body.data.fsCallsAllowed).toBe(false);
});

test('manager-only: drafting, settings, folders, import, backtests', async () => {
  const m = request(app(MEMBER));
  const calls = [
    m.post('/api/knowledge/drafts').send({ ticketIds: [1] }),
    m.post('/api/knowledge/drafts/from-ticket/4'),
    m.put('/api/knowledge/growth-settings').send({ reviewDigestEnabled: true }),
    m.get('/api/knowledge/fs-import/folders'),
    m.post('/api/knowledge/fs-import/run'),
    m.get('/api/knowledge/playbooks/3/backtest'),
    m.post('/api/knowledge/playbooks/3/backtest').send({ n: 5, confirm: true }),
    m.delete('/api/knowledge/backtest'),
  ];
  for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
  expect(draftsMock.draftFromTickets).not.toHaveBeenCalled();
  expect(backtestMock.start).not.toHaveBeenCalled();
  expect(importMock.listFolders).not.toHaveBeenCalled();
});

test('drafts: ids and refs resolve in this workspace; the gap cache is cleared', async () => {
  const res = await request(app(ADMIN)).post('/api/knowledge/drafts').send({ ticketIds: [1, 'x'], ticketRefs: ['TP-7'], kind: 'gap', playbookId: 3, topic: 'Revit' });
  expect(res.status).toBe(201);
  expect(refMock.resolveTicketRefOrThrow).toHaveBeenCalledWith('TP-7', 1);
  expect(draftsMock.draftFromTickets).toHaveBeenCalledWith(1, [1, 7], { email: ADMIN.email, name: ADMIN.name }, { playbookId: 3, topic: 'Revit', kind: 'gap' });
  expect(gapsMock.clearCache).toHaveBeenCalledWith(1);
  expect((await request(app(ADMIN)).post('/api/knowledge/drafts').send({})).status).toBe(400);
});

test('drafting is rate limited per person', async () => {
  for (let i = 0; i < DRAFT_RATE_LIMIT; i += 1) {
    expect((await request(app(ADMIN)).post('/api/knowledge/drafts').send({ ticketIds: [1] })).status).toBe(201);
  }
  const res = await request(app(ADMIN)).post('/api/knowledge/drafts').send({ ticketIds: [1] });
  expect(res.status).toBe(429);
  expect(res.headers['retry-after']).toBeDefined();
});

test('promote returns 201 for a new draft and 200 when the existing draft is reopened', async () => {
  draftsMock.draftFromTicket.mockResolvedValueOnce({ article: { id: 9 }, reused: false }).mockResolvedValueOnce({ article: { id: 9 }, reused: true });
  expect((await request(app(ADMIN)).post('/api/knowledge/drafts/from-ticket/4')).status).toBe(201);
  expect((await request(app(ADMIN)).post('/api/knowledge/drafts/from-ticket/4')).status).toBe(200);
});

test('backtest needs an explicit confirm and at most 50 tickets', async () => {
  expect((await request(app(ADMIN)).post('/api/knowledge/playbooks/3/backtest').send({ n: 5 })).status).toBe(400);
  expect((await request(app(ADMIN)).post('/api/knowledge/playbooks/3/backtest').send({ n: 51, confirm: true })).status).toBe(400);
  const ok = await request(app(ADMIN)).post('/api/knowledge/playbooks/3/backtest').send({ n: 5, confirm: true });
  expect(ok.status).toBe(202);
  expect(backtestMock.start).toHaveBeenCalledWith(1, '3', { n: 5, actor: { email: ADMIN.email, name: ADMIN.name } });
  expect((await request(app(ADMIN)).get('/api/knowledge/playbooks/3/backtest?n=7')).status).toBe(200);
  expect(backtestMock.estimate).toHaveBeenCalledWith(1, '3', { n: '7' });
});

test('"Import now" starts a background job (202 + job id); outside production the service answers with the dry-run plan', async () => {
  let res = await request(app(ADMIN)).post('/api/knowledge/fs-import/run').send({});
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ dryRun: true });
  expect(importMock.startImport).toHaveBeenCalledWith(1, { actor: { email: ADMIN.email, name: ADMIN.name }, dryRun: false });
  importMock.startImport.mockResolvedValueOnce({ jobId: 'fsi-1-a', status: 'queued' });
  res = await request(app(ADMIN)).post('/api/knowledge/fs-import/run').send({});
  expect(res.status).toBe(202);
  expect(res.body.data).toEqual({ jobId: 'fsi-1-a', status: 'queued' });
  const st = await request(app(ADMIN)).get('/api/knowledge/fs-import/jobs/fsi-1-a');
  expect(st.body.data).toMatchObject({ jobId: 'fsi-1-a', status: 'running' });
  expect(importMock.jobStatus).toHaveBeenCalledWith(1, 'fsi-1-a');
  expect((await request(app(ADMIN)).get('/api/knowledge/fs-import/status')).status).toBe(200);
  expect((await request(app(MEMBER)).get('/api/knowledge/fs-import/status')).status).toBe(403);
  expect((await request(app(MEMBER)).get('/api/knowledge/fs-import/jobs/fsi-1-a')).status).toBe(403);
});

test('gaps ?refresh=1 needs the review capability; admins and reviewers may, members may not', async () => {
  const denied = await request(app(MEMBER)).get('/api/knowledge/gaps?refresh=1');
  expect(denied.status).toBe(403);
  expect(gapsMock.gaps).not.toHaveBeenCalled();
  expect((await request(app(ADMIN)).get('/api/knowledge/gaps?refresh=1')).status).toBe(200);
  expect(gapsMock.gaps).toHaveBeenLastCalledWith(1, { days: undefined, refresh: true });
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'reviewer' });
  expect((await request(app(MEMBER)).get('/api/knowledge/gaps?refresh=true')).status).toBe(200);
});

test('saving folder ids checks them against the workspace\'s FreshService first', async () => {
  const ok = await request(app(ADMIN)).put('/api/knowledge/growth-settings').send({ fsFolderIds: ['7', 8] });
  expect(ok.status).toBe(200);
  expect(importMock.validateFolderIds).toHaveBeenCalledWith(1, ['7', '8']);
  const { ValidationError } = await import('../src/utils/errors.js');
  importMock.validateFolderIds.mockRejectedValueOnce(new ValidationError('Folder 31337 is not in this workspace\'s FreshService solutions.'));
  settingsMock.update.mockClear();
  const bad = await request(app(ADMIN)).put('/api/knowledge/growth-settings').send({ fsFolderIds: ['31337'] });
  expect(bad.status).toBe(400);
  expect(settingsMock.update).not.toHaveBeenCalled();
  await request(app(ADMIN)).put('/api/knowledge/growth-settings').send({ reviewDigestEnabled: true });
  expect(importMock.validateFolderIds).toHaveBeenCalledTimes(2); // not for other settings
});

test('backtest status and cancel are awaited (they read the shared lease)', async () => {
  backtestMock.status.mockResolvedValueOnce({ status: 'running', done: 1, total: 3 });
  expect((await request(app(MEMBER)).get('/api/knowledge/backtest')).body.data).toEqual({ status: 'running', done: 1, total: 3 });
  backtestMock.cancel.mockResolvedValueOnce({ status: 'running', cancelling: true });
  expect((await request(app(ADMIN)).delete('/api/knowledge/backtest')).body.data).toEqual({ status: 'running', cancelling: true });
});
