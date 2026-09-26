import { jest } from '@jest/globals';

/** Knowledge growth worker: nightly jobs only in quiet hours and once per 20 h; the digest every tick. */
const store = new Map();
const settingsRepoMock = {
  get: jest.fn(async (k) => store.get(k) ?? null),
  set: jest.fn(async (k, v) => { store.set(k, v); }),
};
const solutionsMock = { runAll: jest.fn(async () => ({ workspaces: [] })) };
const fsImportMock = { runAll: jest.fn(async () => []) };
const digestMock = { tick: jest.fn(async () => ({ skipped: 'not_monday_8am' })) };
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepoMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.unstable_mockModule('../src/services/solutionEmbeddingService.js', () => ({ default: solutionsMock }));
jest.unstable_mockModule('../src/services/fsSolutionImportService.js', () => ({ default: fsImportMock }));
jest.unstable_mockModule('../src/services/knowledgeReviewDigestService.js', () => ({ default: digestMock }));

const { KnowledgeGrowthWorker } = await import('../src/services/knowledgeGrowthWorker.js');

const WORKDAY_NOON = new Date('2026-09-29T19:00:00Z'); // Tue 12:00 PDT
const TUE_NIGHT = new Date('2026-09-30T05:00:00Z'); // Tue 22:00 PDT
const WED_NIGHT = new Date('2026-10-01T05:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
});

test('working hours: no nightly job, the digest check still runs', async () => {
  const w = new KnowledgeGrowthWorker();
  const out = await w.tick(WORKDAY_NOON);
  expect(solutionsMock.runAll).not.toHaveBeenCalled();
  expect(fsImportMock.runAll).not.toHaveBeenCalled();
  expect(digestMock.tick).toHaveBeenCalledWith(WORKDAY_NOON);
  expect(out.digest).toEqual({ skipped: 'not_monday_8am' });
});

test('quiet hours: both nightly jobs once, not again the same night, again the next night', async () => {
  const w = new KnowledgeGrowthWorker();
  await w.tick(TUE_NIGHT);
  await w.tick(new Date(TUE_NIGHT.getTime() + 3600e3));
  expect(solutionsMock.runAll).toHaveBeenCalledTimes(1);
  expect(fsImportMock.runAll).toHaveBeenCalledTimes(1);
  // a restart reads the saved state
  await new KnowledgeGrowthWorker().tick(new Date(TUE_NIGHT.getTime() + 2 * 3600e3));
  expect(solutionsMock.runAll).toHaveBeenCalledTimes(1);
  await w.tick(WED_NIGHT);
  expect(solutionsMock.runAll).toHaveBeenCalledTimes(2);
});

test('a failing job never breaks the tick', async () => {
  solutionsMock.runAll.mockRejectedValueOnce(new Error('boom'));
  const out = await new KnowledgeGrowthWorker().tick(TUE_NIGHT);
  expect(out.solutions).toEqual({ error: 'boom' });
  expect(fsImportMock.runAll).toHaveBeenCalled();
});
