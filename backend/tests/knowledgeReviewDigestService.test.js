import { jest } from '@jest/globals';

/**
 * Review-due digest: grouping per owner and category (FreshService imports
 * and ownerless articles left out), Monday 08:00 Pacific once a week per
 * opted-in workspace, and a hard stop on sending outside production.
 */
const prismaMock = {
  knowledgeArticle: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
  appSettings: { create: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
};
// The claim table: a unique key, like app_settings.key.
const claims = new Set();
const claimCreate = async ({ data }) => {
  await new Promise((r) => { setTimeout(r, 1); }); // let two ticks interleave
  if (claims.has(data.key)) throw Object.assign(new Error('Unique constraint failed on the fields: (`key`)'), { code: 'P2002' });
  claims.add(data.key);
  return { id: claims.size, ...data };
};
const settingsMock = { enabledWorkspaces: jest.fn(), record: jest.fn(async () => null) };
const mailMock = { sendTransactionalEmail: jest.fn(async () => ({ sent: true })) };
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/knowledgeSettingsService.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => mailMock);
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({ isEmbeddingConfigured: () => false, embedQueryTexts: jest.fn(), cosineSimilarity: () => 0 }));

const {
  default: service, groupByOwner, digestEmail, isDigestWindow, mailSendingAllowed, KnowledgeReviewDigestService, claimKey, isoWeekKey,
} = await import('../src/services/knowledgeReviewDigestService.js');

const NOW = new Date('2026-09-28T15:30:00Z'); // Monday 08:30 PDT
const old = new Date('2026-01-01T00:00:00Z');
const A = (id, owner, extra = {}) => ({
  id, title: `Article ${id}`, source: 'tp', ownerEmail: owner, categoryId: 10, subcategoryId: 101,
  lastVerifiedAt: old, createdAt: old, reviewEveryDays: 180, ...extra,
});
const ROWS = [
  A(1, 'Vahid@Example.com'),
  A(2, 'vahid@example.com', { subcategoryId: null, categoryId: 20 }),
  A(3, 'mehdi@example.com'),
  A(4, 'mehdi@example.com', { lastVerifiedAt: new Date('2026-09-01T00:00:00Z') }), // not due
  A(5, null), // no owner
  A(6, 'vahid@example.com', { source: 'fs_solution' }), // FreshService owns it
];
const NAMES = new Map([[10, 'Software'], [101, 'Software → Installation'], [20, 'Access']]);

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.knowledgeArticle.findMany.mockResolvedValue(ROWS);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 10, name: 'Software', parentId: null }, { id: 101, name: 'Installation', parentId: 10 }, { id: 20, name: 'Access', parentId: null }]);
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT' });
  claims.clear();
  prismaMock.appSettings.create.mockImplementation(claimCreate);
});

test('groups due articles per owner (case-insensitive) and category; skips fs_solution, ownerless, not-due', () => {
  const out = groupByOwner(ROWS, NAMES, NOW.getTime());
  expect(out.map((o) => [o.ownerEmail, o.count])).toEqual([['vahid@example.com', 2], ['mehdi@example.com', 1]]);
  expect(out[0].groups.map((g) => g.category)).toEqual(['Access', 'Software → Installation']);
  expect(out[0].groups[1].articles[0]).toMatchObject({ id: 1, daysOverdue: expect.any(Number) });
});

test('the e-mail lists each article with a link, grouped, Outlook-safe', () => {
  const [owner] = groupByOwner(ROWS, NAMES, NOW.getTime());
  const mail = digestEmail({ owner, workspaceName: 'IT', baseUrl: 'https://tp.example.com' });
  expect(mail.subject).toBe('2 Knowledge articles due for review');
  expect(mail.html).toMatch(/href="https:\/\/tp\.example\.com\/knowledge\/articles\/1"/);
  expect(mail.html).not.toMatch(/gradient/);
  expect(mail.text).toMatch(/Software → Installation/);
});

test('Monday 08:00-08:59 Pacific only', () => {
  expect(isDigestWindow(NOW)).toBe(true);
  expect(isDigestWindow(new Date('2026-09-28T14:59:00Z'))).toBe(false); // 07:59 PDT
  expect(isDigestWindow(new Date('2026-09-29T15:30:00Z'))).toBe(false); // Tuesday
});

test('forOwner returns only the signed-in person\'s due list', async () => {
  const mine = await service.forOwner(1, 'vahid@example.com');
  const arg = prismaMock.knowledgeArticle.findMany.mock.calls[0][0];
  expect(arg.where.ownerEmail).toEqual({ equals: 'vahid@example.com', mode: 'insensitive' });
  expect(arg.where.source).toEqual({ not: 'fs_solution' });
  expect(arg.take).toBeLessThanOrEqual(5000);
  expect(mine.count).toBeGreaterThan(0);
  expect(await service.forOwner(1, null)).toEqual({ count: 0, groups: [] });
});

test('tick: opted-in workspaces once a week; sending is a production-only path', async () => {
  expect(mailSendingAllowed({ NODE_ENV: 'development' })).toBe(false);
  settingsMock.enabledWorkspaces.mockResolvedValue([
    { workspaceId: 1, reviewDigestSentAt: null },
    { workspaceId: 2, reviewDigestSentAt: new Date('2026-09-28T15:05:00Z') }, // already this week
  ]);
  const out = await service.tick(NOW);
  expect(out.workspaces).toHaveLength(1);
  expect(out.workspaces[0]).toMatchObject({ workspaceId: 1, owners: 2, sent: 0, dryRun: true });
  expect(mailMock.sendTransactionalEmail).not.toHaveBeenCalled();
  expect(settingsMock.record).toHaveBeenCalledWith(1, { reviewDigestSentAt: NOW });
  expect(await service.tick(new Date('2026-09-29T15:30:00Z'))).toEqual({ skipped: 'not_monday_8am' });
});

test('with sending allowed, one mail per owner through the transactional helper', async () => {
  const out = await service.sendForWorkspace(1, { now: NOW, send: true });
  expect(out).toMatchObject({ owners: 2, sent: 2, dryRun: false });
  expect(mailMock.sendTransactionalEmail).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: 1, to: ['vahid@example.com'], label: 'knowledge-review-digest', html: expect.any(String),
  }));
});

describe('week claim (no double send across containers)', () => {
  test('ISO week keys use the Pacific calendar', () => {
    expect(isoWeekKey(NOW)).toBe('2026-W40');
    expect(isoWeekKey(new Date('2026-01-01T07:00:00Z'))).toBe('2026-W01'); // Thu 1 Jan (Pacific: still Wed 31 Dec 23:00 -> 2026-W01 too)
    expect(isoWeekKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(claimKey(3, NOW)).toBe('knowledge_review_digest:3:2026-W40');
  });

  test('two containers ticking at the same moment: exactly one claims and sends', async () => {
    settingsMock.enabledWorkspaces.mockResolvedValue([{ workspaceId: 1, reviewDigestSentAt: null }]);
    const a = new KnowledgeReviewDigestService();
    const b = new KnowledgeReviewDigestService();
    const sendA = jest.spyOn(a, 'sendForWorkspace').mockResolvedValue({ owners: 2, sent: 2, dryRun: false });
    const sendB = jest.spyOn(b, 'sendForWorkspace').mockResolvedValue({ owners: 2, sent: 2, dryRun: false });
    const [ra, rb] = await Promise.all([a.tick(NOW), b.tick(NOW)]);
    expect(sendA.mock.calls.length + sendB.mock.calls.length).toBe(1);
    expect([ra.workspaces[0], rb.workspaces[0]]).toEqual(expect.arrayContaining([{ workspaceId: 1, skipped: 'claimed' }]));
    expect(prismaMock.appSettings.create).toHaveBeenCalledWith({ data: expect.objectContaining({ key: 'knowledge_review_digest:1:2026-W40' }) });
  });

  test('a restart later the same Monday (sentAt not yet recorded) does not send again', async () => {
    settingsMock.enabledWorkspaces.mockResolvedValue([{ workspaceId: 1, reviewDigestSentAt: null }]);
    const first = new KnowledgeReviewDigestService();
    jest.spyOn(first, 'sendForWorkspace').mockRejectedValue(new Error('container stopped mid-send'));
    await first.tick(NOW);
    const second = new KnowledgeReviewDigestService();
    const send = jest.spyOn(second, 'sendForWorkspace');
    const out = await second.tick(new Date(NOW.getTime() + 20 * 60e3));
    expect(send).not.toHaveBeenCalled();
    expect(out.workspaces).toEqual([{ workspaceId: 1, skipped: 'claimed' }]);
  });

  test('next week is a new claim; any claim error skips rather than risking a double send', async () => {
    settingsMock.enabledWorkspaces.mockResolvedValue([{ workspaceId: 1, reviewDigestSentAt: null }]);
    const svc = new KnowledgeReviewDigestService();
    const send = jest.spyOn(svc, 'sendForWorkspace').mockResolvedValue({ owners: 0, sent: 0, dryRun: true });
    await svc.tick(NOW);
    await svc.tick(new Date(NOW.getTime() + 7 * 86400e3));
    expect(send).toHaveBeenCalledTimes(2);
    prismaMock.appSettings.create.mockRejectedValueOnce(new Error('connection reset'));
    const out = await svc.tick(new Date(NOW.getTime() + 14 * 86400e3));
    expect(out.workspaces).toEqual([{ workspaceId: 1, skipped: 'claimed' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
