import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Knowledge routes (Auto-help P0): members read, only canManageKnowledge
 * (global or workspace admins) writes; the shadow mode lock surfaces as a
 * 400 with the P0 message; settings GET tells the UI whether it may edit;
 * the test endpoint resolves a ticket ref and runs synchronously.
 */
const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  autoHelpRun: { groupBy: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  knowledgeArticle: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  ticket: { findFirst: jest.fn() },
};
const runnerMock = {
  runForTicket: jest.fn(), listRuns: jest.fn(), getRun: jest.fn(), latestForTicket: jest.fn(), waiting: jest.fn(), review: jest.fn(), summary: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({
  default: runnerMock,
  disclosureLine: (settings, name) => (settings?.disclosureText ? String(settings.disclosureText).split('{{workspace}}').join(name || 'support') : null),
}));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
}));

const { default: router, canManageKnowledge, _resetTestRateLimit, TEST_RATE_LIMIT } = await import('../src/routes/knowledge.routes.js');

const ADMIN = { email: 'root@example.com', name: 'Root', role: 'admin' };
const MEMBER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };
const WS_ADMIN = { email: 'wsadmin@example.com', name: 'WS Admin', role: 'user' };
const REVIEWER = { email: 'rev@example.com', name: 'Rev', role: 'user' };

function app(user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { user }; req.workspaceId = 1; next(); });
  a.use('/api/knowledge', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
}

const PB_ROW = { id: 3, workspaceId: 1, name: 'Installs', enabled: false, mode: 'shadow', categoryId: 10, subcategoryIds: [], match: null, instructions: '', allowedTools: [], kbScope: null, minConfidence: 0.8, followUp: null, onHelp: 'assign_normally', priority: 100, version: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  _resetTestRateLimit();
  prismaMock.workspaceAccess.findUnique.mockImplementation(async ({ where }) => (
    where.email_workspaceId.email === WS_ADMIN.email ? { role: 'admin' } : (where.email_workspaceId.email === REVIEWER.email ? { role: 'reviewer' } : { role: 'viewer' })
  ));
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue(null);
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([PB_ROW]);
  prismaMock.autoHelpPlaybook.findFirst.mockResolvedValue(PB_ROW);
  prismaMock.autoHelpPlaybook.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
});

describe('canManageKnowledge', () => {
  test('global admins and workspace admins only', async () => {
    expect(await canManageKnowledge(ADMIN, 1)).toBe(true);
    expect(await canManageKnowledge(WS_ADMIN, 1)).toBe(true);
    expect(await canManageKnowledge(MEMBER, 1)).toBe(false);
    expect(await canManageKnowledge(null, 1)).toBe(false);
  });
});

describe('knowledge routes', () => {
  test('members read playbooks; settings say they cannot manage', async () => {
    const list = await request(app(MEMBER)).get('/api/knowledge/playbooks');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: 3, mode: 'shadow' });
    const settings = await request(app(MEMBER)).get('/api/knowledge/settings');
    expect(settings.body.data).toMatchObject({ canManage: false, enabled: false, disclosureEnabled: true, modeLocked: true });
    expect(settings.body.data.tools.map((t) => t.name)).toContain('search_knowledge');
    // K3: the strip shows the line as requesters read it, not the raw {{workspace}} template.
    expect(settings.body.data.disclosurePreview).not.toMatch(/\{\{/);
  });

  test('members cannot write (403) — articles, playbooks, settings, test runs', async () => {
    const a = app(MEMBER);
    expect((await request(a).post('/api/knowledge/playbooks').send({ name: 'x' })).status).toBe(403);
    expect((await request(a).post('/api/knowledge/articles').send({ title: 'x' })).status).toBe(403);
    expect((await request(a).put('/api/knowledge/settings').send({ enabled: true })).status).toBe(403);
    expect((await request(a).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-1' })).status).toBe(403);
    expect(prismaMock.autoHelpPlaybook.create).not.toHaveBeenCalled();
    expect(runnerMock.runForTicket).not.toHaveBeenCalled();
  });

  test('workspace admins create playbooks, always in shadow mode', async () => {
    const res = await request(app(WS_ADMIN)).post('/api/knowledge/playbooks').send({ name: 'Installs', categoryId: 10 });
    expect(res.status).toBe(201);
    expect(prismaMock.autoHelpPlaybook.create.mock.calls[0][0].data.mode).toBe('shadow');
  });

  test('approve / auto modes are refused with the next-phase message', async () => {
    const res = await request(app(ADMIN)).put('/api/knowledge/playbooks/3').send({ mode: 'auto' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Approve and auto modes come in the next phase');
    const s = await request(app(ADMIN)).put('/api/knowledge/settings').send({ mode: 'approve' });
    expect(s.status).toBe(400);
    expect(prismaMock.autoHelpPlaybook.update).not.toHaveBeenCalled();
  });

  test('test on a ticket resolves the ref and runs synchronously', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 's', status: 'Open', origin: 'ticketpulse', nativeNumber: 12, freshserviceTicketId: null });
    runnerMock.runForTicket.mockResolvedValue({ id: 901, status: 'drafted', draftHtml: '<p>hi</p>' });
    const res = await request(app(ADMIN)).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-12' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('drafted');
    expect(runnerMock.runForTicket).toHaveBeenCalledWith(55, expect.objectContaining({ trigger: 'test', playbookId: 3, workspaceId: 1 }));
  });

  test('an unknown ticket ref is a 404 with a helpful message', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(null);
    const res = await request(app(ADMIN)).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-99999' });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/No ticket matching/);
  });

  test('categories come back as a tree', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 10, name: 'Software & Apps', parentId: null }, { id: 101, name: 'Installation', parentId: 10 },
    ]);
    const res = await request(app(MEMBER)).get('/api/knowledge/categories');
    expect(res.body.data).toEqual([{ id: 10, name: 'Software & Apps', subcategories: [{ id: 101, name: 'Installation' }] }]);
  });

  test('test runs are rate limited per person (429 with a friendly message)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 's', status: 'Open', origin: 'ticketpulse', nativeNumber: 12, freshserviceTicketId: null });
    runnerMock.runForTicket.mockResolvedValue({ id: 901, status: 'drafted' });
    const a = app(ADMIN);
    for (let i = 0; i < TEST_RATE_LIMIT; i += 1) {
      expect((await request(a).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-12' })).status).toBe(200);
    }
    const limited = await request(a).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-12' });
    expect(limited.status).toBe(429);
    expect(limited.body.message).toMatch(/test runs in a minute/);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(runnerMock.runForTicket).toHaveBeenCalledTimes(TEST_RATE_LIMIT);
    // Someone else is not affected.
    expect((await request(app(WS_ADMIN)).post('/api/knowledge/playbooks/3/test').send({ ticketRef: 'TP-12' })).status).toBe(200);
  });

  test('deleting an article archives it', async () => {
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ id: 5, status: 'draft' });
    prismaMock.knowledgeArticle.update.mockResolvedValue({});
    const res = await request(app(ADMIN)).delete('/api/knowledge/articles/5');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ archived: true, status: 'archived' });
    expect(prismaMock.knowledgeArticle.update.mock.calls[0][0].data.status).toBe('archived');
  });

  test('R6 review: workspace reviewers and admins may review, viewers may not; reviewers still cannot manage', async () => {
    runnerMock.review.mockResolvedValue({ id: 901, reviewVerdict: 'good' });
    const ok = await request(app(REVIEWER)).post('/api/knowledge/runs/901/review').send({ verdict: 'good', note: 'spot on' });
    expect(ok.status).toBe(200);
    expect(runnerMock.review).toHaveBeenCalledWith(1, '901', { verdict: 'good', note: 'spot on' }, { email: 'rev@example.com', name: 'Rev' });
    expect((await request(app(WS_ADMIN)).post('/api/knowledge/runs/901/review').send({ verdict: 'wrong' })).status).toBe(200);
    expect((await request(app(MEMBER)).post('/api/knowledge/runs/901/review').send({ verdict: 'good' })).status).toBe(403);
    expect((await request(app(REVIEWER)).post('/api/knowledge/playbooks').send({ name: 'x' })).status).toBe(403);
    const settings = await request(app(REVIEWER)).get('/api/knowledge/settings');
    expect(settings.body.data).toMatchObject({ canManage: false, canReview: true });
  });

  test('R6 per-playbook summary is readable by members', async () => {
    runnerMock.summary.mockResolvedValue([{ playbookId: 3, runs: 4, reviewed: 1 }]);
    const res = await request(app(MEMBER)).get('/api/knowledge/runs-summary?from=2026-09-01');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ playbookId: 3, reviewed: 1 });
    expect(runnerMock.summary).toHaveBeenCalledWith(1, { from: '2026-09-01' });
  });

  test('R1 "Mark as verified" is a manager action', async () => {
    prismaMock.knowledgeArticle.findFirst.mockResolvedValue({ id: 5 });
    prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => ({ id: 5, title: 'T', bodyText: 'b', status: 'published', ...data }));
    const res = await request(app(ADMIN)).post('/api/knowledge/articles/5/verify');
    expect(res.status).toBe(200);
    expect(res.body.data.lastVerifiedAt).toBeTruthy();
    expect((await request(app(REVIEWER)).post('/api/knowledge/articles/5/verify')).status).toBe(403);
  });
});
