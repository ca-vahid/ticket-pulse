import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Knowledge library (plans/KNOWLEDGE_SIMPLIFY_PLAN.md, phase 2):
 *  - rights by skill: propose / write / check from the levels people have;
 *    a top-category skill covers its subcategories; lookups fail closed
 *  - trust: what a checker publishes is Checked, anyone else "Not checked
 *    yet"; an edit by a non-checker un-checks; checking brings it back
 *  - versions: every change is a version; restore makes a new one
 *  - signals: reuse is review; two bad signals take an article out of
 *    automatic answers (the one automatic action, in the safe direction)
 *  - routes: writers by skill, a second person in always-checked categories,
 *    anyone can flag, the assignee can judge an answer
 */
const prismaMock = {
  workspaceAccess: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  knowledgeSettings: { findUnique: jest.fn() },
  knowledgeCategoryPolicy: { findMany: jest.fn() },
  knowledgeArticle: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  knowledgeArticleVersion: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
  knowledgeSignal: { create: jest.fn(), findMany: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn() },
  autoHelpRun: { findFirst: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  autoHelpSettings: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn() },
};
const runnerMock = {
  review: jest.fn(), latestForTicket: jest.fn(), getRun: jest.fn(),
  budgetState: jest.fn(async () => ({ capUsd: null, spentUsd: 0, exhausted: false })),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/autoHelpRunner.js', () => ({ default: runnerMock, disclosureLine: () => null }));
jest.unstable_mockModule('../src/services/availabilityService.js', () => ({ default: { isBusinessHours: jest.fn(async () => ({ isBusinessHours: true })) } }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(async () => null), cosineSimilarity: () => 0,
  nearestVerifiedSolutions: jest.fn(async () => ({ cosById: new Map(), topIds: [] })),
  solutionContentOf: () => '', solutionHashOf: () => 'h', EMBEDDING_MODEL: 'text-embedding-3-small',
}));

const { default: rights, levelIn, rightsIn, rankOf } = await import('../src/services/knowledgeRights.js');
const { default: signals, citedArticleIds, distinctBad, DEMOTE_AFTER } = await import('../src/services/knowledgeSignals.js');
const { default: articles, healthOf } = await import('../src/services/knowledgeArticleService.js');
const { default: policy } = await import('../src/services/knowledgeAnswerPolicy.js');
const { default: router } = await import('../src/routes/knowledge.routes.js');

// Software & Apps (10) > OpenGround (101), Installs (102); Account & Access (20) > Passwords (201).
const CATS = [
  { id: 10, name: 'Software & Apps', parentId: null, sortOrder: 0 }, { id: 101, name: 'OpenGround', parentId: 10, sortOrder: 0 }, { id: 102, name: 'Installs', parentId: 10, sortOrder: 1 },
  { id: 20, name: 'Account & Access', parentId: null, sortOrder: 1 }, { id: 201, name: 'Passwords', parentId: 20, sortOrder: 0 },
];
const PARENTS = new Map(CATS.map((c) => [c.id, c.parentId]));
const PEOPLE = {
  'admin@example.com': { access: 'admin', tech: null, skills: [] },
  'expert@example.com': { access: 'viewer', tech: 1, skills: [[10, 'expert'], [20, 'advanced']] },
  'mid@example.com': { access: 'viewer', tech: 2, skills: [[101, 'intermediate']] },
  'basic@example.com': { access: 'viewer', tech: 3, skills: [[10, 'basic']] },
  'nobody@example.com': { access: 'viewer', tech: 4, skills: [] },
};
const user = (email) => ({ email, name: email.split('@')[0], role: 'user' });
const ART = {
  id: 7, workspaceId: 1, source: 'tp', title: 'OpenGround: install and access', bodyHtml: '<h2>Install</h2><p>Use Company Portal.</p>', bodyText: 'Install Use Company Portal.',
  categoryId: 10, subcategoryId: 101, tags: ['openground'], status: 'published', contentHash: 'x', confidence: 'checked', checkedBy: 'expert@example.com',
  checkedAt: new Date('2026-10-01T00:00:00Z'), lastVerifiedAt: new Date('2026-10-01T00:00:00Z'), reviewEveryDays: 180, version: 3, updatedBy: 'expert@example.com',
  createdAt: new Date('2026-09-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'), embedding: [], sections: [],
};

let stored = null;
// The article writes only (indexing a published article is a second update of sections / vectors).
const writes = () => prismaMock.knowledgeArticle.update.mock.calls.map((c) => c[0].data).filter((d) => !('sections' in d && Object.keys(d).every((k) => ['sections', 'embedding'].includes(k))));

beforeEach(() => {
  jest.clearAllMocks();
  rights.clearCache();
  policy.clearCache();
  prismaMock.workspaceAccess.findUnique.mockImplementation(async ({ where }) => ({ role: PEOPLE[where.email_workspaceId.email]?.access || 'viewer' }));
  prismaMock.technician.findFirst.mockImplementation(async ({ where }) => {
    const p = PEOPLE[String(where.email.equals).toLowerCase()];
    return p?.tech ? { id: p.tech } : null;
  });
  prismaMock.technicianCompetency.findMany.mockImplementation(async ({ where }) => {
    const p = Object.values(PEOPLE).find((x) => x.tech === where.technicianId);
    return (p?.skills || []).map(([competencyCategoryId, proficiencyLevel]) => ({ competencyCategoryId, proficiencyLevel }));
  });
  prismaMock.competencyCategory.findMany.mockResolvedValue(CATS);
  prismaMock.knowledgeSettings.findUnique.mockResolvedValue(null);
  prismaMock.knowledgeCategoryPolicy.findMany.mockResolvedValue([{ workspaceId: 1, categoryId: 20, alwaysChecked: true, stayQuietWhen: [] }]);
  stored = { ...ART };
  prismaMock.knowledgeArticle.findFirst.mockImplementation(async () => ({ ...stored }));
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([]);
  prismaMock.knowledgeArticle.create.mockImplementation(async ({ data }) => {
    stored = { id: 8, createdAt: new Date(), updatedAt: new Date(), reviewEveryDays: 180, embedding: [], sections: [], ...data };
    return { ...stored };
  });
  prismaMock.knowledgeArticle.update.mockImplementation(async ({ data }) => { stored = { ...stored, ...data }; return { ...stored }; });
  prismaMock.knowledgeArticle.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.knowledgeArticleVersion.create.mockResolvedValue({});
  prismaMock.knowledgeArticleVersion.findMany.mockResolvedValue([]);
  // The version an article is on has its row, unless a test says otherwise.
  prismaMock.knowledgeArticleVersion.findFirst.mockResolvedValue({ id: 1 });
  prismaMock.knowledgeSignal.create.mockImplementation(async ({ data }) => ({ id: Math.floor(Math.random() * 1e6), ...data }));
  prismaMock.knowledgeSignal.findMany.mockResolvedValue([]);
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue([]);
  prismaMock.autoHelpRun.findMany.mockResolvedValue([]);
  prismaMock.autoHelpRun.groupBy.mockResolvedValue([]);
  prismaMock.autoHelpSettings.findUnique.mockResolvedValue({ workspaceId: 1, enabled: true, knowledgeFirst: true });
});

describe('rights by skill', () => {
  test('levels: a top-category skill covers its subcategories; a subcategory skill counts for that subcategory and for the top itself', () => {
    expect(['basic', 'intermediate', 'advanced', 'expert', 'nonsense'].map(rankOf)).toEqual([1, 2, 3, 4, 0]);
    const top = new Map([[10, 4]]);
    expect(levelIn(top, PARENTS, { categoryId: 10, subcategoryId: 101 })).toBe(4);
    expect(levelIn(top, PARENTS, { categoryId: 20 })).toBe(0);
    const sub = new Map([[101, 2]]);
    expect(levelIn(sub, PARENTS, { categoryId: 10, subcategoryId: 101 })).toBe(2);
    expect(levelIn(sub, PARENTS, { categoryId: 10, subcategoryId: 102 })).toBe(0);
    expect(levelIn(sub, PARENTS, { categoryId: 10 })).toBe(2);
    expect(levelIn(sub, PARENTS, { subcategoryId: 101 })).toBe(2);
    expect(levelIn(sub, PARENTS, {})).toBe(0);
  });

  test('propose at basic, write at intermediate, check at advanced; admins everything; a second person in always-checked categories', async () => {
    const at = (email, target) => rights.rightsFor(user(email), 1, target);
    expect(await at('basic@example.com', { categoryId: 10 })).toMatchObject({ propose: true, write: false, check: false });
    expect(await at('mid@example.com', { categoryId: 10, subcategoryId: 101 })).toMatchObject({ propose: true, write: true, check: false, selfCheck: false });
    expect(await at('mid@example.com', { categoryId: 10, subcategoryId: 102 })).toMatchObject({ write: false });
    expect(await at('expert@example.com', { categoryId: 10, subcategoryId: 102 })).toMatchObject({ write: true, check: true, selfCheck: true });
    // Account & Access is always checked by a person: the expert may check, but not their own article.
    expect(await at('expert@example.com', { categoryId: 20, subcategoryId: 201 })).toMatchObject({ write: true, check: true, selfCheck: false });
    expect(await at('nobody@example.com', { categoryId: 10 })).toMatchObject({ propose: false, write: false, check: false });
    expect(await at('admin@example.com', { categoryId: 20 })).toMatchObject({ write: true, check: true, selfCheck: true });
    expect(rightsIn(null, { categoryId: 10 })).toMatchObject({ write: false, check: false });
  });

  test('a failed lookup hands out nothing', async () => {
    prismaMock.technician.findFirst.mockRejectedValue(new Error('db down'));
    prismaMock.workspaceAccess.findUnique.mockRejectedValue(new Error('db down'));
    expect(await rights.rightsFor(user('expert@example.com'), 1, { categoryId: 10 })).toMatchObject({ write: false, check: false });
  });

  test('the workspace can move the levels; the check level is never below the publish level', async () => {
    prismaMock.knowledgeSettings.findUnique.mockResolvedValue({ publishLevel: 'advanced', checkLevel: 'basic' });
    expect(await rights.rightsFor(user('mid@example.com'), 1, { categoryId: 10, subcategoryId: 101 })).toMatchObject({ write: false, check: false });
    expect(await rights.rightsFor(user('expert@example.com'), 1, { categoryId: 10 })).toMatchObject({ write: true, check: true });
  });

  test('summary for the UI and the people who could write in a category (no photos)', async () => {
    const sum = await rights.summary(user('mid@example.com'), 1);
    expect(sum).toMatchObject({ isAdmin: false, technician: true, canWriteSomewhere: true, canCheckSomewhere: false, publishLevel: 'intermediate', checkLevel: 'advanced' });
    expect(sum.categories[101]).toMatchObject({ level: 2, write: true, check: false });
    expect(sum.categories[102]).toBeUndefined();
    prismaMock.technicianCompetency.findMany.mockResolvedValue([
      { proficiencyLevel: 'expert', technician: { id: 1, name: 'Ex Pert', email: 'Expert@Example.com' } },
      { proficiencyLevel: 'intermediate', technician: { id: 2, name: 'Mid Level', email: 'mid@example.com' } },
      { proficiencyLevel: 'basic', technician: { id: 3, name: 'Ba Sic', email: 'basic@example.com' } },
    ]);
    const people = await rights.skilledPeople(1, { categoryId: 10 });
    expect(people).toEqual([{ technicianId: 1, name: 'Ex Pert', email: 'expert@example.com', level: 4 }, { technicianId: 2, name: 'Mid Level', email: 'mid@example.com', level: 2 }]);
    expect(prismaMock.technicianCompetency.findMany.mock.calls.at(-1)[0].where.competencyCategoryId.in.sort()).toEqual([10, 101, 102]);
  });
});

describe('trust and versions', () => {
  test('health in one word', () => {
    const now = new Date('2026-10-12T00:00:00Z').getTime();
    expect(healthOf({ ...ART }, now)).toBe('checked');
    expect(healthOf({ ...ART, confidence: 'not_checked' }, now)).toBe('not_checked');
    expect(healthOf({ ...ART, confidence: 'needs_look' }, now)).toBe('needs_look');
    expect(healthOf({ ...ART, lastVerifiedAt: new Date('2025-01-01T00:00:00Z') }, now)).toBe('out_of_date');
    expect(healthOf({ ...ART, status: 'draft' }, now)).toBe('draft');
    expect(healthOf({ ...ART, status: 'archived' }, now)).toBe('archived');
  });

  test('what a checker publishes is Checked; anyone else publishes "Not checked yet"; version 1 is recorded', async () => {
    const input = { title: 'New', bodyHtml: '<p>Steps</p>', status: 'published', categoryId: 10 };
    const checked = await articles.create(1, input, { email: 'expert@example.com' }, { canCheck: true });
    expect(checked).toMatchObject({ confidence: 'checked', health: 'checked', version: 1 });
    expect(prismaMock.knowledgeArticle.create.mock.calls[0][0].data).toMatchObject({ confidence: 'checked', checkedBy: 'expert@example.com', version: 1 });
    const unchecked = await articles.create(1, input, { email: 'mid@example.com' }, { canCheck: false });
    expect(unchecked).toMatchObject({ confidence: 'not_checked', health: 'not_checked' });
    expect(prismaMock.knowledgeArticle.create.mock.calls[1][0].data.checkedBy).toBeUndefined();
    expect(prismaMock.knowledgeArticleVersion.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.knowledgeArticleVersion.create.mock.calls[0][0].data).toMatchObject({ articleId: 8, version: 1, title: 'New', changeNote: 'Created' });
    // A draft is never Checked.
    expect((await articles.create(1, { ...input, status: 'draft' }, { email: 'expert@example.com' }, { canCheck: true })).confidence).toBe('not_checked');
  });

  test('an edit by a non-checker un-checks the article; a checker\'s edit keeps it checked; both make a new version', async () => {
    await articles.update(1, 7, { bodyHtml: '<p>Changed steps</p>' }, { email: 'mid@example.com' }, { canCheck: false, changeNote: 'Fixed step 2' });
    expect(writes()[0]).toMatchObject({ confidence: 'not_checked', version: 4 });
    expect(prismaMock.knowledgeArticleVersion.create.mock.calls[0][0].data).toMatchObject({ version: 4, changedBy: 'mid@example.com', changeNote: 'Fixed step 2' });
    await articles.update(1, 7, { bodyHtml: '<p>Changed again</p>' }, { email: 'expert@example.com' }, { canCheck: true });
    expect(writes()[1]).toMatchObject({ confidence: 'checked', checkedBy: 'expert@example.com', version: 5 });
  });

  test('a change that touches nothing people read (owner, review interval) makes no version and leaves the trust alone', async () => {
    await articles.update(1, 7, { reviewEveryDays: 90 }, { email: 'mid@example.com' }, { canCheck: false });
    const data = writes()[0];
    expect(data.version).toBeUndefined();
    expect(data.confidence).toBeUndefined();
    expect(prismaMock.knowledgeArticleVersion.create).not.toHaveBeenCalled();
  });

  test('checking sets Checked (and brings a doubtful article back); restore makes a NEW version from an old one', async () => {
    stored = { ...ART, confidence: 'needs_look' };
    await articles.verify(1, 7, { email: 'expert@example.com' });
    expect(writes()[0]).toMatchObject({ confidence: 'checked', checkedBy: 'expert@example.com' });
    prismaMock.knowledgeArticleVersion.findFirst.mockResolvedValue({ version: 2, title: 'Old title', bodyHtml: '<p>Old steps</p>', categoryId: 10, subcategoryId: 101, tags: ['old'] });
    await articles.restore(1, 7, 2, { email: 'expert@example.com' });
    expect(writes()[1]).toMatchObject({ title: 'Old title', version: 4 });
    expect(prismaMock.knowledgeArticleVersion.create.mock.calls.at(-1)[0].data).toMatchObject({ version: 4, changeNote: 'Restored version 2' });
  });

  test('a version that cannot be recorded never blocks the save', async () => {
    prismaMock.knowledgeArticleVersion.create.mockRejectedValue(new Error('table missing'));
    await expect(articles.update(1, 7, { title: 'Renamed' }, { email: 'expert@example.com' })).resolves.toMatchObject({ title: 'Renamed' });
  });

  test('QA 10-13: the first edit of an article with no saved version keeps the old text first, so it can be restored', async () => {
    stored = { ...ART, version: 1, bodyHtml: '<p>First text</p>', updatedBy: 'vhaeri@example.com', updatedAt: new Date('2026-09-29T02:04:08Z') };
    prismaMock.knowledgeArticleVersion.findFirst.mockResolvedValue(null);
    await articles.update(1, 7, { bodyHtml: '<p>Second text</p>' }, { email: 'sxu@example.com' }, { canCheck: true });
    const rows = prismaMock.knowledgeArticleVersion.create.mock.calls.map((c) => c[0].data);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ articleId: 7, version: 1, bodyHtml: '<p>First text</p>', changedBy: 'vhaeri@example.com', createdAt: new Date('2026-09-29T02:04:08Z') });
    expect(rows[1]).toMatchObject({ version: 2, bodyHtml: '<p>Second text</p>', changedBy: 'sxu@example.com' });
    // The lookup failing keeps nothing (never a duplicate row), and never blocks the save.
    prismaMock.knowledgeArticleVersion.create.mockClear();
    prismaMock.knowledgeArticleVersion.findFirst.mockRejectedValue(new Error('down'));
    await expect(articles.update(1, 7, { title: 'Renamed' }, { email: 'sxu@example.com' })).resolves.toMatchObject({ title: 'Renamed' });
    expect(prismaMock.knowledgeArticleVersion.create).toHaveBeenCalledTimes(1);
  });

  test('QA 10-13: History always lists the version the article is on, and that version can be read even when its row was never saved', async () => {
    prismaMock.knowledgeArticleVersion.findMany.mockResolvedValue([]);
    const list = await articles.versions(1, 7);
    expect(list).toMatchObject({ current: 3, items: [{ id: 'current-7', version: 3, title: ART.title }] });
    prismaMock.knowledgeArticleVersion.findFirst.mockResolvedValue(null);
    await expect(articles.getVersion(1, 7, 3)).resolves.toMatchObject({ version: 3, bodyHtml: ART.bodyHtml });
    await expect(articles.getVersion(1, 7, 2)).rejects.toThrow('That version was not found');
  });

  test('the Library tree counts articles, drafts and what needs attention, per category and for me', async () => {
    prismaMock.knowledgeArticle.findMany.mockResolvedValue([
      { ...ART, id: 1, ownerEmail: 'mid@example.com' },
      { ...ART, id: 2, confidence: 'not_checked', subcategoryId: 102 },
      { ...ART, id: 3, confidence: 'needs_look' },
      { ...ART, id: 4, status: 'draft', ownerEmail: 'MID@example.com' },
      { ...ART, id: 5, categoryId: null, subcategoryId: null },
    ]);
    const tree = await articles.library(1, { email: 'mid@example.com' });
    expect(tree.totals).toEqual({ articles: 4, drafts: 1, attention: 1, notChecked: 1 });
    expect(tree.mine).toMatchObject({ articles: 1, drafts: 1 });
    expect(tree.uncategorised.articles).toBe(1);
    const software = tree.categories.find((c) => c.id === 10);
    expect(software).toMatchObject({ articles: 3, drafts: 1, attention: 1, notChecked: 1 });
    expect(software.subcategories.find((x) => x.id === 101)).toMatchObject({ articles: 2, drafts: 1, attention: 1 });
    expect(tree.categories.find((c) => c.id === 20)).toMatchObject({ articles: 0, drafts: 0 });
  });
});

describe('signals', () => {
  const RUN = { id: 900, ticketId: 55, categoryId: 10, sources: [{ type: 'article', id: 7, cited: true }, { type: 'article', id: 9, cited: false }, { type: 'ticket', id: 3, cited: true }] };

  test('reuse is review: the verdict lands on every article the answer quoted, and only those', async () => {
    expect(citedArticleIds(RUN)).toEqual([7]);
    await signals.recordReview(1, RUN, 'good', { email: 'Mid@Example.com' });
    expect(prismaMock.knowledgeSignal.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeSignal.create.mock.calls[0][0].data).toMatchObject({ kind: 'good', articleId: 7, ticketId: 55, runId: 900, categoryId: 10, actor: 'mid@example.com' });
    // "Should not have answered" says nothing about the article.
    await signals.recordReview(1, RUN, 'should_not_answer', { email: 'mid@example.com' });
    expect(prismaMock.knowledgeSignal.create).toHaveBeenCalledTimes(1);
  });

  test('two bad signals from different tickets or people take an article out of automatic answers; one does not', async () => {
    expect(DEMOTE_AFTER).toBe(2);
    expect(distinctBad([{ kind: 'wrong', ticketId: 1 }, { kind: 'wrong', ticketId: 1 }, { kind: 'good', ticketId: 2 }])).toBe(1);
    expect(distinctBad([{ kind: 'wrong', ticketId: 1 }, { kind: 'flagged', actor: 'a@x' }])).toBe(2);
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ id: 1, kind: 'wrong', ticketId: 55, actor: 'mid@example.com' }]);
    expect(await signals.recordReview(1, RUN, 'wrong', { email: 'mid@example.com' })).toEqual([]);
    expect(prismaMock.knowledgeArticle.updateMany).not.toHaveBeenCalled();

    prismaMock.knowledgeSignal.findMany.mockResolvedValue([{ id: 1, kind: 'wrong', ticketId: 55, actor: 'mid@example.com' }, { id: 2, kind: 'flagged', ticketId: null, actor: 'expert@example.com' }]);
    expect(await signals.recordReview(1, RUN, 'wrong', { email: 'mid@example.com' })).toEqual([7]);
    expect(prismaMock.knowledgeArticle.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 7, status: 'published' }, data: { confidence: 'needs_look' } });
    expect(prismaMock.knowledgeSignal.create.mock.calls.at(-1)[0].data).toMatchObject({ kind: 'demoted', articleId: 7 });
    // Only signals since the article was last checked count.
    expect(prismaMock.knowledgeSignal.findMany.mock.calls.at(-1)[0].where.createdAt.gte.getTime()).toBeGreaterThanOrEqual(ART.checkedAt.getTime());
  });

  test('an article already marked, a draft, or a failed write: never throws, never demotes twice', async () => {
    stored = { ...ART, confidence: 'needs_look' };
    expect(await signals.demoteIfDoubtful(1, 7)).toBe(false);
    stored = { ...ART, status: 'draft' };
    expect(await signals.demoteIfDoubtful(1, 7)).toBe(false);
    prismaMock.knowledgeSignal.create.mockRejectedValue(new Error('db down'));
    await expect(signals.record(1, { kind: 'good', articleId: 7 })).resolves.toBeNull();
    await expect(signals.record(1, { kind: 'not-a-kind', articleId: 7 })).resolves.toBeNull();
  });

  test('stats for the reader: counts, the last person who confirmed it in use, recent flags', async () => {
    prismaMock.knowledgeSignal.findMany.mockResolvedValue([
      { articleId: 7, kind: 'good', actor: 'mid@example.com', note: null, createdAt: new Date('2026-10-10T00:00:00Z') },
      { articleId: 7, kind: 'good', actor: 'expert@example.com', note: null, createdAt: new Date('2026-10-05T00:00:00Z') },
      { articleId: 7, kind: 'flagged', actor: 'basic@example.com', note: 'Step 2 is out of date', createdAt: new Date('2026-10-04T00:00:00Z') },
    ]);
    const s = (await signals.stats(1, [7, 8])).get(7);
    expect(s).toMatchObject({ good: 2, flagged: 1, wrong: 0, lastGoodBy: 'mid@example.com' });
    expect(s.flags[0]).toMatchObject({ note: 'Step 2 is out of date' });
  });
});

describe('routes', () => {
  const app = (u) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.session = { user: u }; req.workspaceId = 1; next(); });
    a.use('/api/knowledge', router);
    // eslint-disable-next-line no-unused-vars
    a.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message, code: err.code }));
    return a;
  };
  const body = { title: 'OpenGround licence', bodyHtml: '<p>Steps</p>', status: 'published', categoryId: 10, subcategoryId: 101 };

  test('writing is by skill: intermediate publishes as Not checked yet, an expert as Checked, others are refused', async () => {
    expect((await request(app(user('basic@example.com'))).post('/api/knowledge/articles').send(body)).body.code).toBe('knowledge_write_required');
    expect((await request(app(user('nobody@example.com'))).post('/api/knowledge/articles').send(body)).status).toBe(403);
    const mid = await request(app(user('mid@example.com'))).post('/api/knowledge/articles').send(body);
    expect(mid.status).toBe(201);
    expect(mid.body.data.confidence).toBe('not_checked');
    const expert = await request(app(user('expert@example.com'))).post('/api/knowledge/articles').send(body);
    expect(expert.body.data.confidence).toBe('checked');
    // Someone skilled in one subcategory cannot write in another.
    expect((await request(app(user('mid@example.com'))).post('/api/knowledge/articles').send({ ...body, subcategoryId: 102 })).status).toBe(403);
  });

  test('editing needs the skill for the article, and for where it is moved to', async () => {
    const mid = app(user('mid@example.com'));
    expect((await request(mid).put('/api/knowledge/articles/7').send({ title: 'Renamed' })).status).toBe(200);
    expect((await request(mid).put('/api/knowledge/articles/7').send({ subcategoryId: 102 })).body.code).toBe('knowledge_write_required');
    expect((await request(app(user('basic@example.com'))).put('/api/knowledge/articles/7').send({ title: 'x' })).status).toBe(403);
  });

  test('checking needs the check level; in an always-checked category it is a second person', async () => {
    expect((await request(app(user('mid@example.com'))).post('/api/knowledge/articles/7/verify')).body.code).toBe('knowledge_check_required');
    expect((await request(app(user('expert@example.com'))).post('/api/knowledge/articles/7/verify')).status).toBe(200);
    stored = { ...ART, categoryId: 20, subcategoryId: 201, updatedBy: 'expert@example.com' };
    expect((await request(app(user('expert@example.com'))).post('/api/knowledge/articles/7/verify')).body.code).toBe('knowledge_second_person');
    expect((await request(app(user('admin@example.com'))).post('/api/knowledge/articles/7/verify')).status).toBe(200);
    stored = { ...ART, categoryId: 20, subcategoryId: 201, updatedBy: 'someone.else@example.com' };
    expect((await request(app(user('expert@example.com'))).post('/api/knowledge/articles/7/verify')).status).toBe(200);
  });

  test('anyone can flag with a sentence; the reader gets how the article did and what they may do', async () => {
    const nobody = app(user('nobody@example.com'));
    expect((await request(nobody).post('/api/knowledge/articles/7/flag').send({ note: '' })).status).toBe(400);
    const res = await request(nobody).post('/api/knowledge/articles/7/flag').send({ note: 'Step 2 is out of date', ticketId: 55 });
    expect(res.status).toBe(201);
    expect(prismaMock.knowledgeSignal.create.mock.calls[0][0].data).toMatchObject({ kind: 'flagged', articleId: 7, ticketId: 55, actor: 'nobody@example.com', note: 'Step 2 is out of date' });
    const read = await request(app(user('mid@example.com'))).get('/api/knowledge/articles/7');
    expect(read.body.data).toMatchObject({ health: 'checked', version: 3, my: { write: true, check: false, level: 2 } });
    expect(read.body.data.use).toMatchObject({ good: 0, flagged: 0 });
    // QA 10-13: an admin with no skill here is told that is why they can write; a skilled writer is not.
    expect(read.body.data.my.asAdmin).toBe(false);
    expect((await request(app(user('admin@example.com'))).get('/api/knowledge/articles/7')).body.data.my).toMatchObject({ write: true, asAdmin: true });
  });

  test('judging an answer: the assignee, people with the skill, reviewers and admins; the verdict reaches the quoted articles', async () => {
    prismaMock.autoHelpRun.findFirst.mockResolvedValue({ ticketId: 55, categoryId: 20, subcategoryId: 201 });
    prismaMock.ticket.findFirst.mockResolvedValue({ assignedTechId: 4, internalCategoryId: 20, internalSubcategoryId: 201 });
    runnerMock.review.mockResolvedValue({ id: 900, ticketId: 55, categoryId: 20, sources: [{ type: 'article', id: 7, cited: true }] });
    // The assignee (technician 4) has no skill at all, and may still judge their own ticket's answer.
    const assignee = await request(app(user('nobody@example.com'))).post('/api/knowledge/runs/900/review').send({ verdict: 'good' });
    expect(assignee.status).toBe(200);
    expect(prismaMock.knowledgeSignal.create.mock.calls[0][0].data).toMatchObject({ kind: 'good', articleId: 7, runId: 900 });
    // Skilled in the run's category.
    expect((await request(app(user('expert@example.com'))).post('/api/knowledge/runs/900/review').send({ verdict: 'partial' })).status).toBe(200);
    // Neither assignee nor skilled there.
    expect((await request(app(user('mid@example.com'))).post('/api/knowledge/runs/900/review').send({ verdict: 'good' })).body.code).toBe('knowledge_review_required');
    expect((await request(app(user('admin@example.com'))).post('/api/knowledge/runs/900/review').send({ verdict: 'good' })).status).toBe(200);
  });

  test('the ticket\'s Knowledge panel: articles that fit, the latest run, and whether I may judge it', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 55, subject: 'OpenGround install', descriptionText: 'How do I install OpenGround?', internalCategoryId: 10, internalSubcategoryId: 101, assignedTechId: 2 });
    prismaMock.knowledgeArticle.findMany.mockImplementation(async ({ select }) => (select?.sections ? [{ id: 7, sections: null }] : [{ ...ART, bodyText: 'OpenGround install: use Company Portal to install OpenGround.' }]));
    runnerMock.latestForTicket.mockResolvedValue({ id: 900, status: 'drafted' });
    prismaMock.autoHelpRun.findFirst.mockResolvedValue({ ticketId: 55, categoryId: 10, subcategoryId: 101 });
    const res = await request(app(user('mid@example.com'))).get('/api/knowledge/tickets/55/knowledge');
    expect(res.status).toBe(200);
    expect(res.body.data.articles[0]).toMatchObject({ id: 7, title: 'OpenGround: install and access', confidence: 'checked' });
    expect(res.body.data).toMatchObject({ run: { id: 900 }, canReview: true, my: { write: true } });
  });

  test('settings carry the person\'s rights; history is readable by members, restore needs the skill', async () => {
    const settings = await request(app(user('mid@example.com'))).get('/api/knowledge/settings');
    expect(settings.body.data.rights).toMatchObject({ canWriteSomewhere: true, isAdmin: false });
    prismaMock.knowledgeArticleVersion.findMany.mockResolvedValue([{ id: 1, version: 3, title: 'T', status: 'published', changedBy: 'expert@example.com', changeNote: null, createdAt: new Date() }]);
    expect((await request(app(user('nobody@example.com'))).get('/api/knowledge/articles/7/versions')).body.data).toMatchObject({ current: 3, items: [{ version: 3 }] });
    prismaMock.knowledgeArticleVersion.findFirst.mockResolvedValue({ version: 2, title: 'Old', bodyHtml: '<p>Old</p>', categoryId: 10, subcategoryId: 101, tags: [] });
    expect((await request(app(user('nobody@example.com'))).post('/api/knowledge/articles/7/versions/2/restore')).status).toBe(403);
    expect((await request(app(user('mid@example.com'))).post('/api/knowledge/articles/7/versions/2/restore')).status).toBe(200);
  });
});
