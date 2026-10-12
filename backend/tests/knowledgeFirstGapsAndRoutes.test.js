import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Knowledge-first (plans/KNOWLEDGE_SIMPLIFY_PLAN.md):
 *  - gaps are grouped by the ticket's top category, so a category with no
 *    playbook shows its gaps; "a person had to do it" is never a gap
 *  - GET/PUT /knowledge/answering: any member reads the dial, only Knowledge
 *    managers change it, and the earned lock surfaces as a 400 with its code
 */
const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn(), findFirst: jest.fn() },
  autoHelpRun: { groupBy: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn(), upsert: jest.fn() },
  knowledgeArticle: { findMany: jest.fn(), groupBy: jest.fn() },
  knowledgeCategoryPolicy: { findMany: jest.fn(), upsert: jest.fn() },
  workspace: { findUnique: jest.fn() },
  ticket: { findMany: jest.fn(), findFirst: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({
  default: { budgetState: jest.fn(async () => ({ capUsd: null, spentUsd: 0, exhausted: false })) },
  disclosureLine: () => null,
}));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn(async () => ({ isBusinessHours: true })) } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
  solutionContentOf: () => '', solutionHashOf: () => 'h', EMBEDDING_MODEL: 'text-embedding-3-small',
}));

const { default: gaps, NOT_A_GAP_GATES } = await import('../src/services/knowledgeGapService.js');
const { default: policyService } = await import('../src/services/knowledgeAnswerPolicy.js');
const { default: router } = await import('../src/routes/knowledge.routes.js');

const at = (d) => new Date(`2026-10-${String(d).padStart(2, '0')}T10:00:00Z`);
const T = (id, subject, categoryId, extra = {}) => ({
  id, workspaceId: 1, subject, descriptionText: `${subject}. Thanks.`, status: 'Open', isNoise: false, createdAt: at(1),
  resolvedAt: null, solutionVerifiedAt: null, origin: 'ticketpulse', nativeNumber: id, freshserviceTicketId: null,
  internalCategoryId: categoryId, internalSubcategoryId: null, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  gaps.clearCache();
  policyService.clearCache();
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, knowledgeFirst: true });
  prismaMock.competencyCategory.findMany.mockResolvedValue([
    { id: 10, name: 'Software & Apps', parentId: null, sortOrder: 0 },
    { id: 30, name: 'Devices & Hardware', parentId: null, sortOrder: 1 },
  ]);
  prismaMock.competencyCategory.findFirst.mockImplementation(async ({ where }) => ([10, 30].includes(where.id) ? { id: where.id, parentId: null } : null));
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([]);
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  prismaMock.knowledgeArticle.groupBy.mockResolvedValue([]);
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
  prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([]);
  prismaMock.knowledgeCategoryPolicy.upsert.mockResolvedValue({});
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT', defaultTimezone: 'America/Vancouver' });
  prismaMock.workspaceAccess.findUnique.mockImplementation(async ({ where }) => (where.email_workspaceId.email === 'wsadmin@example.com' ? { role: 'admin' } : { role: 'viewer' }));
});

describe('gaps by category', () => {
  test('a category with no playbook shows its gaps; needs_person, Off and old "no playbook fits" rows are not gaps', async () => {
    prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => {
      // The second read asks which of these tickets were answered later.
      if (where.status?.in) return [];
      return [
        { id: 1, ticketId: 1, playbookId: 40, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(9) },
        { id: 2, ticketId: 2, playbookId: 40, status: 'not_answerable', gateDecision: 'insufficient_context', createdAt: at(8) },
        { id: 3, ticketId: 3, playbookId: 40, status: 'not_answerable', gateDecision: 'model_declined', createdAt: at(7) },
        { id: 4, ticketId: 4, playbookId: 40, status: 'no_match', gateDecision: 'needs_person', createdAt: at(6) },
        { id: 5, ticketId: 5, playbookId: null, status: 'no_match', gateDecision: 'no_match', createdAt: at(5) },
      ];
    });
    prismaMock.ticket.findMany.mockResolvedValue([
      T(1, 'Docking station not detected', 30), T(2, 'Docking station shows no display', 30), T(3, 'How do I use Bookings', 10),
      T(4, 'Please grant mailbox access', 10), T(5, 'Server backup failed', 30),
    ]);

    const out = await gaps.compute(1, { days: 30 });

    expect(NOT_A_GAP_GATES).toEqual(['needs_person', 'category_off']);
    expect(out.groupedBy).toBe('category');
    expect(out.totals.tickets).toBe(3);
    const hardware = out.playbooks.find((g) => g.categoryId === 30);
    expect(hardware).toMatchObject({ playbookName: 'Devices & Hardware', playbookId: null, groupKind: 'category', groupKey: 'c30', tickets: 2 });
    expect(out.playbooks.find((g) => g.categoryId === 10)).toMatchObject({ playbookName: 'Software & Apps', tickets: 1 });
    // No playbook rows were needed at all.
    expect(out.playbooks.flatMap((g) => g.clusters.flatMap((c) => c.ticketIds)).sort()).toEqual([1, 2, 3]);
  });

  test('the playbook-gated workspace keeps its grouping', async () => {
    prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, knowledgeFirst: false });
    prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([{ id: 1, name: 'Installs', enabled: true, categoryId: 10, subcategoryIds: [], priority: 100 }]);
    prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => (where.status?.in ? [] : [
      { id: 1, ticketId: 3, playbookId: 1, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(9) },
    ]));
    prismaMock.ticket.findMany.mockResolvedValue([T(3, 'How do I use Bookings', 10)]);
    const out = await gaps.compute(1, { days: 30 });
    expect(out.groupedBy).toBe('playbook');
    expect(out.playbooks[0]).toMatchObject({ playbookId: 1, playbookName: 'Installs', groupKind: 'playbook' });
  });
});

describe('/knowledge/answering', () => {
  const app = (user) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.session = { user }; req.workspaceId = 1; next(); });
    a.use('/api/knowledge', router);
    // eslint-disable-next-line no-unused-vars
    a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
    return a;
  };
  const MEMBER = { email: 'viewer@example.com', name: 'Viewer', role: 'user' };
  const WS_ADMIN = { email: 'wsadmin@example.com', name: 'WS Admin', role: 'user' };

  test('any member reads the dial, with the order switch and whether they may change it', async () => {
    prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([{ workspaceId: 1, categoryId: 10, dayLevel: 'suggest', nightLevel: null, bar: null, alwaysChecked: null, notes: null, stayQuietWhen: [] }]);
    const res = await request(app(MEMBER)).get('/api/knowledge/answering');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ knowledgeFirst: true, enabled: true, canManage: false, afterHoursNow: false });
    expect(res.body.data.categories.find((c) => c.id === 10).resolved).toMatchObject({ dayLevel: 'suggest', nightLevel: 'draft' });
    expect(res.body.data.default.resolved).toMatchObject({ dayLevel: 'draft', nightLevel: 'draft' });
  });

  test('only Knowledge managers change it; the earned lock is a 400 with its code', async () => {
    expect((await request(app(MEMBER)).put('/api/knowledge/answering/10').send({ dayLevel: 'suggest' })).status).toBe(403);
    expect(prismaMock.knowledgeCategoryPolicy.upsert).not.toHaveBeenCalled();

    const ok = await request(app(WS_ADMIN)).put('/api/knowledge/answering/10').send({ dayLevel: 'suggest', notes: 'Never quote prices.' });
    expect(ok.status).toBe(200);
    expect(prismaMock.knowledgeCategoryPolicy.upsert.mock.calls[0][0].create).toMatchObject({ workspaceId: 1, categoryId: 10, dayLevel: 'suggest', notes: 'Never quote prices.', updatedBy: 'wsadmin@example.com' });

    prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
    const locked = await request(app(WS_ADMIN)).put('/api/knowledge/answering/10').send({ nightLevel: 'send' });
    expect(locked.status).toBe(400);
    expect(locked.body.code).toBe('knowledge_send_not_earned');
  });

  test('the order switch is a workspace setting only managers can flip', async () => {
    prismaMock.autoHelpSettings.upsert.mockResolvedValue({});
    expect((await request(app(MEMBER)).put('/api/knowledge/settings').send({ knowledgeFirst: true })).status).toBe(403);
    const res = await request(app(WS_ADMIN)).put('/api/knowledge/settings').send({ knowledgeFirst: true });
    expect(res.status).toBe(200);
    expect(prismaMock.autoHelpSettings.upsert.mock.calls[0][0].update).toMatchObject({ knowledgeFirst: true });
  });
});
