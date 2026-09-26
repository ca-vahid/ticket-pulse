import { jest } from '@jest/globals';
import { createFakePrisma, matches } from './helpers/fakePrismaStore.js';

/**
 * Verified-solution embeddings: subject + solution note only (never the
 * description or notes), incremental by content hash, bounded per run, new
 * work first and then an oldest-first backfill, vectors removed ONLY when the
 * verified mark / note / ticket is gone (never because a solution is old),
 * category moves without a new embedding call, and the retrieval reader
 * never throws.
 */
let db;
const prismaMock = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/config/index.js', () => ({ default: { openai: { apiKey: null } } }));

const embeddings = await import('../src/services/ticketEmbeddingService.js');
const { EMBEDDING_MODEL, solutionContentOf, solutionHashOf, nearestVerifiedSolutions } = embeddings;
const { SolutionEmbeddingService, orderWork, NEW_WINDOW_DAYS } = await import('../src/services/solutionEmbeddingService.js');

const fakeOpenAi = { embeddings: { create: jest.fn() } };
const NOW = new Date('2026-09-25T10:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400e3);
const T = (id, note, { cat = 10, verifiedAt = daysAgo(1), ws = 1 } = {}) => ({
  id, workspaceId: ws, subject: `Subject ${id}`, solutionNote: note, internalCategoryId: cat, solutionVerifiedAt: verifiedAt, descriptionText: 'secret',
});
const vec = (t, extra = {}) => ({
  ticketId: t.id, workspaceId: t.workspaceId, contentHash: solutionHashOf(solutionContentOf(t)), model: EMBEDDING_MODEL, categoryId: t.internalCategoryId, embedding: [1, 1], ...extra,
});

function seed({ tickets = [], vectors = [], workspaces = [{ id: 1, isActive: true }] } = {}) {
  db = createFakePrisma({ ticket: tickets, ticketSolutionEmbedding: vectors.map((v, i) => ({ id: 100 + i, ...v })), workspace: workspaces });
  // The shared fake has no deleteMany; the service's stale cleanup needs one.
  const store = db._rows('ticketSolutionEmbedding');
  db.ticketSolutionEmbedding.deleteMany = jest.fn(async ({ where }) => {
    const before = store.length;
    for (let i = store.length - 1; i >= 0; i -= 1) if (matches(store[i], where)) store.splice(i, 1);
    return { count: before - store.length };
  });
  return db;
}
const vectorsOf = () => db._rows('ticketSolutionEmbedding');

let svc;
beforeEach(() => {
  jest.clearAllMocks();
  embeddings.default._setClient(fakeOpenAi);
  fakeOpenAi.embeddings.create.mockImplementation(async ({ input }) => ({ data: input.map((_, index) => ({ index, embedding: [index + 1, 1] })) }));
  svc = new SolutionEmbeddingService();
  svc.pauseMs = 0;
});

test('solution content is subject + verified note, nothing else', () => {
  expect(solutionContentOf({ subject: 'VPN drops', solutionNote: 'Reinstalled GlobalProtect', descriptionText: 'secret' })).toBe('VPN drops\nReinstalled GlobalProtect');
  expect(solutionContentOf({ subject: 'x', solutionNote: '  ' })).toBe('');
});

test('embeds new and changed solutions, skips unchanged, fixes categories, drops rows whose mark or note is gone', async () => {
  const unchanged = T(2, 'Same note');
  const moved = T(4, 'Moved', { cat: 20 });
  seed({
    tickets: [T(1, 'New note'), unchanged, T(3, 'Changed note'), moved, T(5, ''), T(9, 'Unmarked', { verifiedAt: null }), T(6, '')],
    vectors: [
      vec(unchanged),
      vec(T(3, 'Changed note'), { contentHash: 'old' }),
      vec(moved, { categoryId: 10 }),
      vec(T(9, 'Unmarked')), // no longer verified
      vec(T(6, 'had a note')), // note emptied
      vec(T(77, 'gone')), // ticket deleted
    ],
  });
  const out = await svc.embedWorkspace(1, { now: NOW });
  expect(out).toMatchObject({ embedded: 2, unchanged: 1, recategorized: 1, removed: 3, pending: 0 });
  expect(fakeOpenAi.embeddings.create).toHaveBeenCalledTimes(1);
  expect(fakeOpenAi.embeddings.create.mock.calls[0][0].input.sort()).toEqual(['Subject 1\nNew note', 'Subject 3\nChanged note']);
  expect(vectorsOf().map((v) => v.ticketId).sort()).toEqual([1, 2, 3, 4]);
  expect(vectorsOf().find((v) => v.ticketId === 4).categoryId).toBe(20);
  expect(JSON.stringify(fakeOpenAi.embeddings.create.mock.calls)).not.toMatch(/secret/);
});

test('REGRESSION: old verified solutions keep their vectors, however many newer ones exist', async () => {
  // 1,200 verified tickets (more than two scan pages); the oldest 700 were
  // verified a year ago. Every one already has a current vector.
  const tickets = Array.from({ length: 1200 }, (_, i) => T(i + 1, `Note ${i + 1}`, { verifiedAt: daysAgo(i < 700 ? 400 : 3) }));
  seed({ tickets, vectors: tickets.map((t) => vec(t)) });
  const out = await svc.embedWorkspace(1, { now: NOW });
  expect(out).toMatchObject({ embedded: 0, removed: 0, unchanged: 1200, pending: 0 });
  expect(db.ticketSolutionEmbedding.deleteMany).not.toHaveBeenCalled();
  expect(vectorsOf()).toHaveLength(1200);
  expect(fakeOpenAi.embeddings.create).not.toHaveBeenCalled();
});

test('new work first (newest first), then the backfill of older solutions oldest first, bounded per run', async () => {
  const fresh = [T(50, 'fresh a', { verifiedAt: daysAgo(1) }), T(51, 'fresh b', { verifiedAt: daysAgo(2) })];
  const changedOld = T(40, 'edited long ago', { verifiedAt: daysAgo(300) });
  const old = Array.from({ length: 6 }, (_, i) => T(i + 1, `old ${i + 1}`, { verifiedAt: daysAgo(100 + i * 10) }));
  seed({ tickets: [...old, changedOld, ...fresh], vectors: [vec(changedOld, { contentHash: 'stale' })] });

  const first = await svc.embedWorkspace(1, { max: 5, now: NOW });
  const firstInputs = fakeOpenAi.embeddings.create.mock.calls.flatMap((c) => c[0].input);
  expect(firstInputs).toEqual(['Subject 50\nfresh a', 'Subject 51\nfresh b', 'Subject 40\nedited long ago', 'Subject 6\nold 6', 'Subject 5\nold 5']);
  expect(first).toMatchObject({ embedded: 5, backfilled: 2, pending: 4, backfillPending: 4 });

  fakeOpenAi.embeddings.create.mockClear();
  const second = await svc.embedWorkspace(1, { max: 10, now: NOW });
  expect(fakeOpenAi.embeddings.create.mock.calls.flatMap((c) => c[0].input)).toEqual(['Subject 4\nold 4', 'Subject 3\nold 3', 'Subject 2\nold 2', 'Subject 1\nold 1']);
  expect(second).toMatchObject({ embedded: 4, backfilled: 4, pending: 0, backfillPending: 0 });
  expect(vectorsOf()).toHaveLength(9);
});

test('orderWork splits at NEW_WINDOW_DAYS', () => {
  const todo = [
    { ticketId: 1, verifiedAt: daysAgo(NEW_WINDOW_DAYS + 1) },
    { ticketId: 2, verifiedAt: daysAgo(1) },
    { ticketId: 3, verifiedAt: daysAgo(400), changed: true },
    { ticketId: 4, verifiedAt: daysAgo(900) },
  ];
  const { fresh, backfill } = orderWork(todo, NOW);
  expect(fresh.map((t) => t.ticketId)).toEqual([2, 3]);
  expect(backfill.map((t) => t.ticketId)).toEqual([4, 1]);
});

test('an embedding failure stops the run quietly; a missing table returns a reason', async () => {
  seed({ tickets: [T(1, 'a')] });
  fakeOpenAi.embeddings.create.mockRejectedValueOnce(new Error('429'));
  expect((await svc.embedWorkspace(1, { now: NOW })).embedded).toBe(0);
  db.ticketSolutionEmbedding.findMany = jest.fn(async () => { throw new Error('relation does not exist'); });
  expect(await svc.embedWorkspace(1, { now: NOW })).toMatchObject({ skipped: 'unavailable' });
});

test('runAll: every workspace\'s new work before anyone\'s backfill, one shared budget', async () => {
  seed({
    workspaces: [{ id: 1, isActive: true }, { id: 2, isActive: true }],
    tickets: [
      ...Array.from({ length: 5 }, (_, i) => T(i + 1, `ws1 old ${i}`, { verifiedAt: daysAgo(200 + i) })),
      T(10, 'ws1 new', { verifiedAt: daysAgo(1) }),
      T(20, 'ws2 new', { ws: 2, verifiedAt: daysAgo(1) }),
      T(21, 'ws2 new too', { ws: 2, verifiedAt: daysAgo(2) }),
    ],
  });
  const out = await svc.runAll({ max: 4, now: NOW });
  const inputs = fakeOpenAi.embeddings.create.mock.calls.flatMap((c) => c[0].input);
  expect(inputs.slice(0, 3).sort()).toEqual(['Subject 10\nws1 new', 'Subject 20\nws2 new', 'Subject 21\nws2 new too']);
  expect(inputs[3]).toBe('Subject 5\nws1 old 4'); // the oldest backfill
  expect(out.workspaces.find((w) => w.workspaceId === 1).embedded).toBe(2);
  expect(out.workspaces.find((w) => w.workspaceId === 2).embedded).toBe(2);
});

describe('nearestVerifiedSolutions (retrieval reader)', () => {
  test('scores every scanned solution, returns the best ids, bounded and category-scoped', async () => {
    seed();
    db.ticketSolutionEmbedding.findMany = jest.fn().mockResolvedValueOnce([
      { id: 1, ticketId: 10, embedding: [1, 0] },
      { id: 2, ticketId: 11, embedding: [0, 1] },
      { id: 3, ticketId: 12, embedding: [0.9, 0.1] },
      { id: 4, ticketId: 55, embedding: [1, 0] }, // the ticket itself
    ]).mockResolvedValue([]);
    const out = await nearestVerifiedSolutions(1, [1, 0], { categoryId: 7, excludeTicketId: 55, limit: 2 });
    expect(out.topIds).toEqual([10, 12]);
    expect(out.cosById.get(11)).toBeCloseTo(0);
    expect(out.cosById.has(55)).toBe(false);
    const arg = db.ticketSolutionEmbedding.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ workspaceId: 1, categoryId: 7, model: EMBEDDING_MODEL });
    expect(arg.take).toBe(500);
  });

  test('no query vector or a missing table -> empty, never throws', async () => {
    seed();
    expect((await nearestVerifiedSolutions(1, null)).topIds).toEqual([]);
    db.ticketSolutionEmbedding.findMany = jest.fn().mockRejectedValueOnce(new Error('relation "ticket_solution_embeddings" does not exist'));
    const out = await nearestVerifiedSolutions(1, [1, 0]);
    expect(out.topIds).toEqual([]);
    expect(out.cosById.size).toBe(0);
  });
});
