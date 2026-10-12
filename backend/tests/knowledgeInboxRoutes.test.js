import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Routes of the Knowledge inbox and contribution (phase 3): who may propose,
 * a flag reaches the inbox once per article, the capture and tidy endpoints,
 * and Home shows a person their own categories.
 */
const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn() },
};
const suggestionMock = { list: jest.fn(), get: jest.fn(), create: jest.fn(), accept: jest.fn(), dismiss: jest.fn(), snooze: jest.fn() };
const captureMock = { shouldAsk: jest.fn(), capture: jest.fn(), tidy: jest.fn() };
const rightsMock = { rightsFor: jest.fn(), summary: jest.fn(), profile: jest.fn() };
const signalsMock = { flag: jest.fn(), record: jest.fn(async () => null), stats: jest.fn(async () => new Map()), recordReview: jest.fn() };
const articleMock = { get: jest.fn(), library: jest.fn(), search: jest.fn() };
const policyMock = { list: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({ default: { budgetState: jest.fn() }, disclosureLine: () => null }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
  solutionContentOf: () => '', solutionHashOf: () => 'h', EMBEDDING_MODEL: 'text-embedding-3-small',
}));
// Other modules import named exports from these: keep the real ones, swap the service object.
const real = {
  articles: await import('../src/services/knowledgeArticleService.js'),
  rights: await import('../src/services/knowledgeRights.js'),
  signals: await import('../src/services/knowledgeSignals.js'),
  policy: await import('../src/services/knowledgeAnswerPolicy.js'),
  suggestions: await import('../src/services/knowledgeSuggestionService.js'),
};
jest.unstable_mockModule('../src/services/knowledgeArticleService.js', () => ({ ...real.articles, default: articleMock }));
jest.unstable_mockModule('../src/services/knowledgeRights.js', () => ({ ...real.rights, default: rightsMock }));
jest.unstable_mockModule('../src/services/knowledgeSignals.js', () => ({ ...real.signals, default: signalsMock }));
jest.unstable_mockModule('../src/services/knowledgeAnswerPolicy.js', () => ({ ...real.policy, default: policyMock }));
jest.unstable_mockModule('../src/services/knowledgeSuggestionService.js', () => ({ ...real.suggestions, default: suggestionMock }));
jest.unstable_mockModule('../src/services/knowledgeCaptureService.js', () => ({ default: captureMock }));

const { default: router, _resetTestRateLimit } = await import('../src/routes/knowledge.routes.js');

const USER = { email: 'mid@example.com', name: 'Mid', role: 'user' };
const app = () => {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.session = { user: USER }; req.workspaceId = 1; next(); });
  a.use('/api/knowledge', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
  return a;
};
const ARTICLE = { id: 7, title: 'OpenGround', categoryId: 10, subcategoryId: 101, timesQuoted: 14 };

beforeEach(() => {
  jest.clearAllMocks();
  _resetTestRateLimit();
  prismaMock.workspaceAccess.findUnique.mockResolvedValue({ role: 'viewer' });
  rightsMock.rightsFor.mockResolvedValue({ level: 1, propose: true, write: false, check: false, selfCheck: false });
  rightsMock.summary.mockResolvedValue({ isAdmin: false, canPropose: true, canWriteSomewhere: false, canCheckSomewhere: false, technician: true, categories: { 101: { level: 2, write: true } } });
  articleMock.get.mockResolvedValue(ARTICLE);
  suggestionMock.create.mockImplementation(async (_ws, input) => ({ suggestion: { id: 9, ...input }, created: true }));
  signalsMock.flag.mockResolvedValue({ recorded: true, demoted: true });
});

describe('inbox routes', () => {
  test('the inbox is read with the person and their filters; an item opens with its proposal', async () => {
    suggestionMock.list.mockResolvedValue({ counts: { mine: 1, categories: 3, all: null }, total: 1, items: [{ id: 5 }] });
    suggestionMock.get.mockResolvedValue({ id: 5, proposed: { bodyHtml: '<p>x</p>' } });
    const res = await request(app()).get('/api/knowledge/inbox?scope=mine&kind=flag');
    expect(res.body.data.counts.mine).toBe(1);
    expect(suggestionMock.list).toHaveBeenCalledWith(1, USER, expect.objectContaining({ scope: 'mine', kind: 'flag' }));
    expect((await request(app()).get('/api/knowledge/suggestions/5')).body.data.proposed.bodyHtml).toBe('<p>x</p>');
  });

  test('proposing: anyone with a skill in the category; the proposer is never sent their own proposal; odd kinds are refused', async () => {
    const res = await request(app()).post('/api/knowledge/suggestions').send({ kind: 'edit', title: 'Step 2 changed', articleId: 7, proposed: { bodyHtml: '<p>New</p>', other: 'dropped' }, why: 'Renamed app' });
    expect(res.status).toBe(201);
    expect(suggestionMock.create.mock.calls[0][1]).toMatchObject({
      kind: 'edit', articleId: 7, categoryId: 10, subcategoryId: 101, createdBy: 'mid@example.com', excludeAssignees: ['mid@example.com'], source: 'person',
      proposed: { bodyHtml: '<p>New</p>', categoryId: 10, subcategoryId: 101 },
    });
    expect(suggestionMock.create.mock.calls[0][1].proposed.other).toBeUndefined();
    expect((await request(app()).post('/api/knowledge/suggestions').send({ kind: 'retire', title: 'x' })).status).toBe(400);
    rightsMock.rightsFor.mockResolvedValue({ propose: false, write: false, check: false });
    expect((await request(app()).post('/api/knowledge/suggestions').send({ kind: 'new_article', title: 'x', categoryId: 20 })).body.code).toBe('knowledge_propose_required');
  });

  test('accept, dismiss and put off pass the person through to the service', async () => {
    suggestionMock.accept.mockResolvedValue({ id: 5, status: 'accepted' });
    suggestionMock.dismiss.mockResolvedValue({ id: 5, status: 'dismissed' });
    suggestionMock.snooze.mockResolvedValue({ id: 5 });
    await request(app()).post('/api/knowledge/suggestions/5/accept').send({ bodyHtml: '<p>Mine</p>' });
    expect(suggestionMock.accept).toHaveBeenCalledWith(1, '5', USER, { bodyHtml: '<p>Mine</p>' });
    await request(app()).post('/api/knowledge/suggestions/5/dismiss').send({ note: 'no' });
    expect(suggestionMock.dismiss).toHaveBeenCalledWith(1, '5', USER, { note: 'no' });
    await request(app()).post('/api/knowledge/suggestions/5/snooze').send({ days: 7 });
    expect(suggestionMock.snooze).toHaveBeenCalledWith(1, '5', USER, { days: 7 });
  });

  test('a flag reaches the inbox: one open item per article, sent to someone else, with the use count as its weight', async () => {
    const res = await request(app()).post('/api/knowledge/articles/7/flag').send({ note: 'Step 2 is out of date', ticketId: 55 });
    expect(res.status).toBe(201);
    expect(suggestionMock.create.mock.calls[0][1]).toMatchObject({
      kind: 'flag', articleId: 7, categoryId: 10, subcategoryId: 101, dedupeKey: 'flag:article:7', reopen: true, impact: 14,
      excludeAssignees: ['mid@example.com'], why: 'Step 2 is out of date', evidence: expect.objectContaining({ ticketId: 55, needsLook: true }),
    });
    // The inbox failing never fails the flag itself.
    suggestionMock.create.mockRejectedValue(new Error('db down'));
    expect((await request(app()).post('/api/knowledge/articles/7/flag').send({ note: 'Still wrong' })).status).toBe(201);
  });
});

describe('contribution routes', () => {
  test('the ask at close and its answer', async () => {
    captureMock.shouldAsk.mockResolvedValue({ ask: true, reason: '6 requests like this…', similar: 6 });
    captureMock.capture.mockResolvedValue({ saved: true, article: { id: 31, title: 'Docks' }, suggestionId: 9 });
    expect((await request(app()).get('/api/knowledge/tickets/55/capture')).body.data).toMatchObject({ ask: true, similar: 6 });
    const yes = await request(app()).post('/api/knowledge/tickets/55/capture').send({ decision: 'yes' });
    expect(yes.status).toBe(201);
    expect(captureMock.capture).toHaveBeenLastCalledWith(1, '55', USER, { decision: 'yes' });
    captureMock.capture.mockResolvedValue({ saved: false });
    expect((await request(app()).post('/api/knowledge/tickets/55/capture').send({ decision: 'not_now' })).status).toBe(200);
    expect(captureMock.capture).toHaveBeenLastCalledWith(1, '55', USER, { decision: 'not_now' });
  });

  test('tidy needs a skill somewhere and returns a proposal', async () => {
    captureMock.tidy.mockResolvedValue({ title: 'Docks', bodyHtml: '<ol><li>Unplug.</li></ol>' });
    const res = await request(app()).post('/api/knowledge/tidy').send({ text: 'unplug the dock', title: 'dock' });
    expect(res.body.data.title).toBe('Docks');
    expect(captureMock.tidy).toHaveBeenCalledWith(1, { text: 'unplug the dock', title: 'dock' });
    rightsMock.summary.mockResolvedValue({ canPropose: false, categories: {} });
    expect((await request(app()).post('/api/knowledge/tidy').send({ text: 'x' })).status).toBe(403);
  });

  test('Home: my inbox and only the categories I have a skill in', async () => {
    suggestionMock.list.mockResolvedValue({ counts: { mine: 2, categories: 4, all: null }, total: 4, items: [{ id: 5 }] });
    articleMock.library.mockResolvedValue({
      totals: { articles: 8 }, mine: { articles: 2 },
      categories: [
        { id: 10, name: 'Software & Apps', articles: 6, drafts: 1, attention: 2, notChecked: 1, subcategories: [{ id: 101, name: 'OpenGround' }] },
        { id: 20, name: 'Devices & Hardware', articles: 0, drafts: 0, attention: 0, notChecked: 0, subcategories: [] },
      ],
    });
    policyMock.list.mockResolvedValue({ categories: [{ id: 10, runs30: { total: 40, answered: 9 }, resolved: { dayLevel: 'suggest' } }] });
    const res = await request(app()).get('/api/knowledge/home');
    expect(res.body.data.inbox.counts.mine).toBe(2);
    expect(res.body.data.categories).toEqual([expect.objectContaining({ id: 10, name: 'Software & Apps', level: 2, attention: 2, runs30: { total: 40, answered: 9 }, dayLevel: 'suggest' })]);
    expect(res.body.data.rights).toMatchObject({ canPropose: true, isAdmin: false });
  });
});
