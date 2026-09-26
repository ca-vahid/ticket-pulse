import { jest } from '@jest/globals';

/**
 * Knowledge gaps: which runs count, one entry per ticket, answered-later
 * tickets drop out, "not picked up" tickets are assigned to the playbook
 * whose category covers them, keyword fallback clusters per playbook, drafted
 * articles are linked back, results are cached.
 */
const prismaMock = {
  autoHelpRun: { findMany: jest.fn() },
  autoHelpPlaybook: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
  knowledgeArticle: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const embedMock = { configured: false, embed: jest.fn(async () => null) };
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  isEmbeddingConfigured: () => embedMock.configured,
  embedQueryTexts: (...a) => embedMock.embed(...a),
  cosineSimilarity: () => 0,
}));

const { default: service, GAP_GATES, NOT_PICKED_UP, coversCategory, gistOf } = await import('../src/services/knowledgeGapService.js');

const PLAYBOOKS = [
  { id: 1, name: 'Software installs', enabled: true, categoryId: 10, subcategoryIds: [101], priority: 100 },
  { id: 2, name: 'Mobile & roaming', enabled: false, categoryId: 20, subcategoryIds: [], priority: 100 },
];
const at = (d) => new Date(`2026-09-${String(d).padStart(2, '0')}T10:00:00Z`);
const T = (id, subject, extra = {}) => ({
  id, workspaceId: 1, subject, descriptionText: `${subject}. Thanks.`, status: 'Open', isNoise: false, createdAt: at(1),
  resolvedAt: null, solutionVerifiedAt: null, origin: 'ticketpulse', nativeNumber: id, freshserviceTicketId: null,
  internalCategoryId: 10, internalSubcategoryId: 101, ...extra,
});
const TICKETS = [
  T(1, 'Install Revit add-in'),
  T(2, 'Revit add-in missing', { status: 'Resolved', resolvedAt: at(5) }),
  T(3, 'Need the Revit add-in manager'),
  T(4, 'Roaming in the US', { internalCategoryId: 20, internalSubcategoryId: 201 }),
  T(5, 'Roaming plan for Europe travel', { internalCategoryId: 20, internalSubcategoryId: 202 }),
  T(6, 'Printer jam', { internalCategoryId: 30, internalSubcategoryId: 301 }), // no playbook covers it
  T(7, 'Install Revit add-in again', { isNoise: true }),
  T(8, 'Answered later: Revit add-in'),
];
const RUNS = [
  { id: 11, ticketId: 1, playbookId: 1, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(10) },
  { id: 12, ticketId: 2, playbookId: 1, status: 'not_answerable', gateDecision: 'insufficient_context', createdAt: at(9) },
  { id: 13, ticketId: 3, playbookId: null, status: 'no_match', gateDecision: 'no_match', createdAt: at(8) },
  { id: 14, ticketId: 4, playbookId: null, status: 'no_match', gateDecision: 'no_match', createdAt: at(7) },
  { id: 15, ticketId: 5, playbookId: 2, status: 'not_answerable', gateDecision: 'model_declined', createdAt: at(6) },
  { id: 16, ticketId: 6, playbookId: null, status: 'no_match', gateDecision: 'no_match', createdAt: at(6) },
  { id: 17, ticketId: 7, playbookId: 1, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(6) },
  { id: 18, ticketId: 8, playbookId: 1, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(3) },
  { id: 19, ticketId: 1, playbookId: 1, status: 'not_answerable', gateDecision: 'uncited_step', createdAt: at(2) }, // older run, same ticket
];

beforeEach(() => {
  jest.clearAllMocks();
  service.clearCache();
  embedMock.configured = false;
  prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => {
    if (where.status?.in) return [{ ticketId: 8, createdAt: at(4) }]; // ticket 8 drafted after its gap run
    return RUNS;
  });
  prismaMock.autoHelpPlaybook.findMany.mockResolvedValue(PLAYBOOKS);
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in ? TICKETS.filter((t) => where.id.in.includes(t.id)) : []));
  prismaMock.knowledgeArticle.findMany.mockResolvedValue([
    { id: 70, title: 'Revit add-ins', status: 'draft', sourceMeta: { draftedFrom: { ticketIds: [1, 2] } } },
  ]);
});

test('queries only knowledge-gap outcomes and categorized no-match runs, bounded', async () => {
  await service.gaps(1, { days: 30 });
  const arg = prismaMock.autoHelpRun.findMany.mock.calls[0][0];
  expect(arg.where.OR).toEqual([
    { status: 'not_answerable', gateDecision: { in: [...GAP_GATES] } },
    { status: 'no_match', trigger: 'categorized' },
  ]);
  expect(arg.take).toBeLessThanOrEqual(1500);
  expect(GAP_GATES).toEqual(expect.arrayContaining(['no_sources', 'no_grounded_source', 'insufficient_context', 'uncited_step']));
  const ticketArg = prismaMock.ticket.findMany.mock.calls[0][0];
  expect(ticketArg.select.photoUrl).toBeUndefined();
  expect(ticketArg.take).toBeLessThanOrEqual(600);
});

test('groups per playbook, one entry per ticket; noise, uncovered and answered-later tickets drop out', async () => {
  const out = await service.gaps(1);
  expect(out.mode).toBe('sparse');
  const sw = out.playbooks.find((p) => p.playbookId === 1);
  const mobile = out.playbooks.find((p) => p.playbookId === 2);
  expect(sw.tickets).toBe(3); // 1, 2, 3 (7 noise, 8 answered later)
  expect(mobile.tickets).toBe(2); // 4 (not picked up, category 20 covered by playbook 2), 5
  const allIds = out.playbooks.flatMap((p) => p.clusters.flatMap((c) => c.ticketIds));
  expect(allIds).not.toEqual(expect.arrayContaining([6]));
  expect(allIds).not.toEqual(expect.arrayContaining([7]));
  expect(allIds).not.toEqual(expect.arrayContaining([8]));
  expect(out.totals.tickets).toBe(5);
});

test('the Revit tickets form one cluster with a typical title, counts, reasons, examples and the drafted article', async () => {
  const out = await service.gaps(1);
  const sw = out.playbooks.find((p) => p.playbookId === 1);
  const revit = sw.clusters.find((c) => c.ticketIds.includes(1));
  expect(revit.count).toBe(3);
  expect(revit.ticketIds.sort()).toEqual([1, 2, 3]);
  expect(revit.title).toMatch(/Revit/);
  expect(revit.keywords).toEqual(expect.arrayContaining(['revit']));
  expect(revit.notPickedUp).toBe(1);
  expect(revit.reasons).toEqual({ no_sources: 1, insufficient_context: 1, [NOT_PICKED_UP]: 1 });
  expect(revit.resolvedCount).toBe(1);
  expect(revit.examples[0]).toMatchObject({ id: 1, ref: expect.any(String), subject: 'Install Revit add-in' });
  expect(revit.examples[0]).not.toHaveProperty('descriptionText');
  expect(revit.article).toEqual({ id: 70, title: 'Revit add-ins', status: 'draft' });
  expect(new Date(revit.lastSeenAt).getTime()).toBe(at(10).getTime());
});

test('cached for 5 minutes; refresh bypasses the cache', async () => {
  await service.gaps(1);
  await service.gaps(1);
  expect(prismaMock.autoHelpRun.findMany).toHaveBeenCalledTimes(2); // gap runs + answered runs, once
  const cached = await service.gaps(1);
  expect(cached.cached).toBe(true);
  await service.gaps(1, { refresh: true });
  expect(prismaMock.autoHelpRun.findMany).toHaveBeenCalledTimes(4);
});

test('with embeddings on, the gap tickets and a background sample are embedded (and cached)', async () => {
  embedMock.configured = true;
  embedMock.embed.mockImplementation(async (texts) => texts.map((t) => (/revit/i.test(t) ? [1, 0.1, 0.05] : /roaming/i.test(t) ? [0.1, 1, 0.05] : [0.2, 0.2, 1])));
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => {
    if (where.id?.in) return TICKETS.filter((t) => where.id.in.includes(t.id));
    return [{ id: 100, subject: 'Monitor flicker', descriptionText: 'Screen flickers' }, { id: 101, subject: 'Keyboard', descriptionText: 'Keys stuck' }];
  });
  const out = await service.gaps(1);
  expect(out.mode).toBe('dense');
  const sw = out.playbooks.find((p) => p.playbookId === 1);
  expect(sw.clusters.find((c) => c.ticketIds.includes(1)).count).toBe(3);
  const embedded = embedMock.embed.mock.calls.flatMap((c) => c[0]).length;
  await service.gaps(1, { refresh: true });
  const embeddedAgain = embedMock.embed.mock.calls.flatMap((c) => c[0]).length - embedded;
  expect(embeddedAgain).toBe(0);
});

test('no runs or no playbooks -> empty, never throws on a missing table', async () => {
  prismaMock.autoHelpRun.findMany.mockRejectedValue(new Error('relation "auto_help_runs" does not exist'));
  const out = await service.gaps(1);
  expect(out.playbooks).toEqual([]);
});

test('helpers', () => {
  expect(coversCategory({ categoryId: 10, subcategoryIds: [101] }, { internalCategoryId: 10, internalSubcategoryId: 102 })).toBe(false);
  expect(coversCategory({ categoryId: 10, subcategoryIds: [] }, { internalCategoryId: 10, internalSubcategoryId: 102 })).toBe(true);
  expect(gistOf({ subject: 'RE: VPN', descriptionText: 'Drops.\nIf you received this in error please delete' })).toBe('VPN\nDrops.');
});

describe('audit fixes (Part B)', () => {
  test('test and backtest runs are never gaps and never count as answers', async () => {
    await service.gaps(1);
    const [gapQuery, answeredQuery] = prismaMock.autoHelpRun.findMany.mock.calls.map((c) => c[0]);
    expect(gapQuery.where.trigger).toEqual({ notIn: ['test', 'backtest'] });
    expect(answeredQuery.where.trigger).toEqual({ notIn: ['test', 'backtest'] });
  });

  test('cluster titles and keywords carry no people\'s names', async () => {
    const nick = { name: 'Nick Stone', email: 'nick.stone@example.com' };
    const extra = [
      T(21, 'NIck stone - EUROPE move', { internalCategoryId: 20, internalSubcategoryId: 202, requester: nick, descriptionText: 'Hi, Nick Stone here, moving to Europe. Roaming for my phone please. Thanks, Nick' }),
      T(22, 'Europe move roaming for Nick Stone', { internalCategoryId: 20, internalSubcategoryId: 202, requester: nick, descriptionText: 'Nick Stone moves to Europe, roaming needed.' }),
      T(23, 'Priya Shah - Europe roaming', { internalCategoryId: 20, internalSubcategoryId: 202, requester: { name: 'Priya Shah' }, descriptionText: 'Europe roaming for Priya Shah' }),
    ];
    const runs = extra.map((t, i) => ({ id: 60 + i, ticketId: t.id, playbookId: 2, status: 'not_answerable', gateDecision: 'no_sources', createdAt: at(20 - i) }));
    prismaMock.autoHelpRun.findMany.mockImplementation(async ({ where }) => (where.status?.in ? [] : runs));
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in ? extra.filter((t) => where.id.in.includes(t.id)) : []));
    const out = await service.gaps(1, { refresh: true });
    const clusters = out.playbooks.flatMap((p) => p.clusters);
    const labels = JSON.stringify(clusters.map((c) => ({ title: c.title, keywords: c.keywords })));
    expect(labels).not.toMatch(/nick|stone|priya|shah/i);
    expect(clusters.map((c) => c.title).join(' | ')).toMatch(/EUROPE move|Europe/i);
  });
});
